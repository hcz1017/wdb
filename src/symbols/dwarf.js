// 主线程侧的 DWARF 引擎客户端（浏览器 / Node 同构）
//
// 协议来自 @vscode/dwarf-debugging 的 WorkerRPC：
//   host → engine:  { requestId, request: { method, params } }            （我们发请求）
//   engine → host:  { requestId, request: { method, params } }            （引擎要宿主做点什么）
//   engine → host:  { requestId, sync_request: { request, io_buffer } }   （同步取 wasm 状态）
//   engine → host:  { requestId, response | error }                       （回我们的请求）
//
// 宿主只需要实现 4 个**同步** getter（都是"暂停快照"读取，不能是 async）：
//   getWasmLinearMemory(offset, length, stopId) -> ArrayBuffer
//   getWasmLocal(local, stopId)                 -> {type:'i32'|'i64'|'f32'|'f64'|'v128', value}
//   getWasmGlobal(global, stopId)               -> 同上
//   getWasmOp(op, stopId)                       -> 同上
import { createWorker } from "../runtime/create-worker.js";

export class DwarfEngine {
  /**
   * @param {string} workerUrl  扩展里 dist/web/dwarfWorker.js 的 URL
   * @param {string} assetsBase 扩展 assets 目录的 URL（下面应有 dwarf/worker.js 与 dwarf/SymbolsBackend.wasm.gz）
   * @param {object} host       4 个同步 getter 的实现
   * @param {object} [opts]
   * @param {(url:string)=>Promise<Worker>} [opts.createWorker] 自定义 worker 工厂（Node 宿主用）
   * @param {boolean} [opts.assumeReady] 引擎不握手 __wdbReady（Node 上游引擎）时直接视为就绪
   */
  constructor(workerUrl, assetsBase, host, opts = {}) {
    this.workerUrl = workerUrl;
    this.worker = null;              // 真正创建见 _ensureWorker()（可能要 fetch+blob）
    this.host = host || {};
    this.nextId = 0;
    this.requests = new Map();
    this.semaphore = new Int32Array(new SharedArrayBuffer(4));
    this.verbose = false;
    this._ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
    this.assetsBase = assetsBase;
    this._createWorker = opts.createWorker || null;
    this._assumeReady = !!opts.assumeReady;
    // worker 的创建/事件绑定/__wdbConfig 发送都在 _ensureWorker()（见下）：
    // 必须延迟且异步，因为跨源或 vscode-file: 时 new Worker(url) 会被拦，要先 fetch 成 blob。
  }

  /**
   * 创建 worker（幂等）。跨源 / vscode-file: 等场景下 new Worker(url) 会被拦，
   * createWorker 会 fetch 成 blob 再建。
   */
  async _ensureWorker() {
    if (this.worker) return this.worker;
    this.worker = this._createWorker
      ? await this._createWorker(this.workerUrl)
      : await createWorker(this.workerUrl, { log: (m) => console.info("[wdb] " + m) });
    this.worker.addEventListener("message", (ev) => this._onMessage(ev.data));
    this.worker.addEventListener("error", (e) => {
      const raw = (e && (e.message || e.error)) || e;
      let msg = "dwarf worker error: " + raw;
      if (/importScripts|failed to load|NetworkError/i.test(String(raw))) {
        msg += `\n提示：worker 脚本 ${this.workerUrl} 加载失败 —— 通常是浏览器缓存了旧版本的扩展。` +
          "请按 Ctrl+Shift+R（Mac: Cmd+Shift+R）强制刷新页面后重试。";
      }
      const err = new Error(msg);
      this._rejectReady(err);
      for (const { reject } of this.requests.values()) reject(err);
      this.requests.clear();
    });
    if (this._assumeReady) {
      // Node 宿主里跑的是上游 node 版引擎：它自己用 fs 读 wasm，没有 __wdbConfig/__wdbReady 握手
      this._resolveReady();
    } else {
      this.worker.postMessage({ __wdbConfig: { base: String(this.assetsBase || "").replace(/\/+$/, "") } });
    }
    return this.worker;
  }

  async start({ logPluginApiCalls = false } = {}) {
    await this._ensureWorker();
    await this._ready;
    // hello 必须最先调用：把模块配置交给引擎
    await this.sendMessage("hello", [], !!logPluginApiCalls);
    return this;
  }

  // ---------------- 上层 API（对应 Chrome LanguageExtensionPlugin） ----------------
  /** 传我们编译出的 wasm（含嵌入式 DWARF）。返回 DWARF 里登记的源文件 URL 数组 */
  addRawModule(rawModuleId, wasmUrl, wasmBytes) {
    const code = toArrayBuffer(wasmBytes);
    return this.sendMessage("addRawModule", rawModuleId, undefined, { url: wasmUrl, code });
  }
  removeRawModule(rawModuleId) { return this.sendMessage("removeRawModule", rawModuleId); }
  /** 源码位置 → wasm raw offset 区间（下断点用）。lineNumber 1-based */
  sourceLocationToRawLocation(sourceLocation) { return this.sendMessage("sourceLocationToRawLocation", sourceLocation); }
  /** wasm raw offset → 源码位置（栈帧/单步用） */
  rawLocationToSourceLocation(rawLocation) { return this.sendMessage("rawLocationToSourceLocation", rawLocation); }
  getFunctionInfo(rawLocation) { return this.sendMessage("getFunctionInfo", rawLocation); }
  getInlinedFunctionRanges(rawLocation) { return this.sendMessage("getInlinedFunctionRanges", rawLocation); }
  getInlinedCalleesRanges(rawLocation) { return this.sendMessage("getInlinedCalleesRanges", rawLocation); }
  getScopeInfo(type) { return this.sendMessage("getScopeInfo", type); }
  listVariablesInScope(rawLocation) { return this.sendMessage("listVariablesInScope", rawLocation); }
  getMappedLines(rawModuleId, sourceFileURL) { return this.sendMessage("getMappedLines", rawModuleId, sourceFileURL); }
  getValueInfo(expression, context, stopId) { return this.sendMessage("getValueInfo", expression, context, stopId); }
  evaluate(expression, context, stopId) { return this.sendMessage("evaluate", expression, context, stopId); }
  getProperties(objectId) { return this.sendMessage("getProperties", objectId); }
  releaseObject(objectId) { return this.sendMessage("releaseObject", objectId); }

  // ---------------- RPC 实现 ----------------
  sendMessage(method, ...params) {
    const requestId = this.nextId++;
    const p = new Promise((resolve, reject) => this.requests.set(requestId, { resolve, reject }));
    this.worker.postMessage({ requestId, request: { method, params } });
    if (this.verbose) console.log("[dwarf→]", method, brief(params));
    return p;
  }

  /** 引擎请求宿主（异步形态）；一般不会用到，兜底实现 */
  async _handleHostRequest(requestId, request) {
    try {
      const fn = this.host[request.method];
      if (typeof fn !== "function") throw new Error("host 未实现 " + request.method);
      const response = await fn(...(request.params || []));
      this.worker.postMessage({ requestId, response });
    } catch (e) {
      this.worker.postMessage({ requestId, error: String((e && e.message) || e) });
    }
  }

  /** 引擎同步请求宿主：写 io_buffer + Atomics 通知（必须同步完成） */
  _handleHostSyncRequest(syncRequest) {
    const { request, io_buffer: ioBuffer } = syncRequest;
    let signal = -1;
    try {
      const fn = this.host[request.method];
      if (typeof fn !== "function") throw new Error("host 未实现 " + request.method);
      const value = fn(...(request.params || []));
      signal = serializeWasmValue(value, ioBuffer.data);
    } catch (e) {
      console.error("[wdb] 同步宿主调用失败", request && request.method, e);
      signal = -1;
    } finally {
      const sem = new Int32Array(ioBuffer.semaphore);
      Atomics.store(sem, 0, signal);
      Atomics.notify(sem, 0);
    }
  }

  _onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.__wdbReady) { this._resolveReady(); return; }
    if (msg.__wdbError) { this._rejectReady(new Error(String(msg.__wdbError))); return; }

    if (msg.sync_request) { this._handleHostSyncRequest(msg.sync_request); return; }
    if (msg.request) { this._handleHostRequest(msg.requestId, msg.request); return; }
    const cb = this.requests.get(msg.requestId);
    if (!cb) return;
    this.requests.delete(msg.requestId);
    if ("error" in msg) cb.reject(new Error(String(msg.error)));
    else {
      // ⚠️ 不要直接 JSON.stringify(...).slice()：hello/addRawModule 等响应可能是 undefined，
      //    JSON.stringify(undefined) 返回 undefined → .slice 抛异常 → 连 resolve 都被打断（表现为永久卡住）
      if (this.verbose) console.log("[dwarf←]", brief(msg.response));
      cb.resolve(msg.response);
    }
  }

  async stop() {
    try { this.worker.terminate(); } catch {}
    for (const { reject } of this.requests.values()) reject(new Error("dwarf engine stopped"));
    this.requests.clear();
  }
}

/** Uint8Array/Buffer/ArrayBuffer → ArrayBuffer（transfer 用，必须是独立的 buffer） */
function toArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

/** 日志用的安全摘要：undefined/函数/循环引用都不能让日志本身抛异常 */
function brief(value, max = 160) {
  try {
    const s = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
    if (s === undefined) return String(value);
    return s.length > max ? s.slice(0, max) + "…" : s;
  } catch {
    return String(value);
  }
}

/** 与上游 WorkerRPC 的 SynchronousIOMessage.serialize 保持一致 */
export function serializeWasmValue(value, buffer) {
  if (value instanceof ArrayBuffer) {
    const data = new Uint8Array(value);
    new Uint8Array(buffer).set(data);
    return data.byteLength || -1;
  }
  const view = new DataView(buffer);
  switch (value && value.type) {
    case "i32": view.setInt32(0, value.value, true); return 1;
    case "i64": view.setBigInt64(0, BigInt(value.value), true); return 2;
    case "f32": view.setFloat32(0, value.value, true); return 3;
    case "f64": view.setFloat64(0, value.value, true); return 4;
    case "v128": {
      const [a, b, c, d] = String(value.value).split(" ").map(Number);
      view.setInt32(0, a, true); view.setInt32(4, b, true);
      view.setInt32(8, c, true); view.setInt32(12, d, true);
      return 5;
    }
    default:
      throw new Error("无法序列化的 wasm 值: " + JSON.stringify(value));
  }
}
