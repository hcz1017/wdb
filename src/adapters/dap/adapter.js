// 极简 DAP（Debug Adapter Protocol）适配器：给 VS Code 的调试 UI 提供 wasm 源码级调试。
//
// 设计取舍（MVP，可靠优先）：
//   · 断点：源码行 → DWARF 行表 → wasm 语句起点 → 插桩 siteId（不支持的行返回 unverified）
//   · 暂停：插桩探针命中 + SharedArrayBuffer/Atomics.wait 阻塞
//   · 调用栈：探针里抓 JS 栈（V8 会给 wasm-function[N]:0xNNN + 函数名），再用 DWARF 映射成 文件:行
//   · 变量：暂停时把线性内存快照给 DWARF 引擎；引擎读 locals/globals 时我们暂无快照 → 显示为不可用
// ⚠️ 这个文件【不能】import "vscode"：它属于 wdb 核心，任何宿主（VS Code / Monaco /
//    CLI）都只是把 DAP 消息喂进来。宿主相关的东西一律通过构造参数注入：
//      terminal: { write(s) }      调试控制台/终端输出
//      onStatus: (text) => void    状态栏提示（可省略）
//      compile:  ({source, fileName, flags, opt, debugInfo, debugStub}) => Promise<{wasm, log, exit}>
import { instrumentWasm, firstInstrOffset, parseWasm } from "../../instrument/wasm-bin.mjs";
import { SparseMem, EMPTY_MEM } from "../../runtime/mem-view.mjs";
import { createWorker } from "../../runtime/create-worker.js";

/**
 * 把来源 URL/路径归一成可比较形式（解码 + 统一分隔符）。
 * ⚠️ 纯 ASCII 文件名时 raw 与 percent-encoded 恰好相同，所以这个坑长期没暴露；
 *    中文等非 ASCII 文件名下，DWARF 引擎返回的 sourceFileURL 与我们自己拼的
 *    "file:///workspace/<名字>" 可能一个编码一个不编码 → 断点查表全部落空
 *    （表现为断点灰色未验证、程序停不下来）。
 */
export function normalizeSourceUrl(u) {
  let s = String(u || "");
  // 只解码，不解成乱码：解码失败就保留原文
  try { s = decodeURIComponent(s); } catch {}
  return s.replace(/\\/g, "/");
}
/** 归一化后的文件名（比较不同来源 URL 时的唯一可靠依据） */
export function sourceBaseName(u) {
  const s = normalizeSourceUrl(u);
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

/** 极小的 onDidX 事件源（替代 vscode.EventEmitter，保持宿主无关） */
class Emitter {
  constructor() {
    this._listeners = new Set();
    this.event = (cb) => { this._listeners.add(cb); return { dispose: () => this._listeners.delete(cb) }; };
  }
  fire(value) { for (const cb of [...this._listeners]) { try { cb(value); } catch {} } }
  dispose() { this._listeners.clear(); }
}




/** 引擎 evaluate 的返回格式 → 给人看的字符串 */
function formatValue(vi) {  if (vi == null) return "<no value>";
  if (typeof vi === "string") return vi;
  if (vi.description != null) return String(vi.description);   // 引擎给的展示串（BigInt 友好）
  if (vi.displayValue != null) return String(vi.displayValue);
  if (vi.value != null) return typeof vi.value === "bigint" ? vi.value.toString() : String(vi.value);
  if (vi.data != null) return typeof vi.data === "string" ? vi.data : JSON.stringify(vi.data);
  return JSON.stringify(vi);
}   // 每次会话重新赋值，避免重复 launch 冲突

export class WasmDebugAdapter {
  /**
   * @param {object} o
   * @param {{source:string,fileName:string,flags:string}} o.target 要调试的源码
   * @param {() => Promise<any>} o.getEngine  返回 DWARF 引擎（已 start）
   * @param {(args:object)=>Promise<{wasm:Uint8Array,log:string,exit:number}>} o.compile 编译成调试产物
   * @param {string} o.workerUrl   调试运行时 worker 的 URL（wdb 的 debug.worker 打包产物）
   * @param {(s:string)=>void} [o.log]
   * @param {(text:string)=>void} [o.onStatus]  状态提示（宿主自己决定画在哪）
   */
  constructor({ target, getEngine, compile, workerUrl, log, onSnapshot, onFrame, terminal, onStatus }) {
    this.target = target;
    this.getEngine = getEngine;
    this.compile = compile;
    this.workerUrl = workerUrl;
    this.log = log || (() => {});
    this.onSnapshot = onSnapshot || (() => {});   // 把暂停时的内存快照交给符号引擎宿主
    this.onFrame = onFrame || (() => {});         // locals 快照位置 + 类型表（引擎读局部变量用）
    this.terminal = terminal || null;             // { write(text), onInput(cb), dispose() }
    this.onStatus = onStatus || null;              // 状态栏提示（可省略）
    this._seq = 1;
    this._emitter = new Emitter();
    this.onDidSendMessage = this._emitter.event;

    this.session = null;        // { engine, orig, instr, sites, sitesByLine, codeBase, importCount, bodies }
    this.worker = null;
    this.sab = null;
    this.ctrl = null;
    this.stdinSab = null;
    this.stdinCtrl = null;
    this.stdinBuf = null;
    this._inputQueue = [];      // 终端输入缓冲（宿主只能在工作线程空闲时写单槽）
    this.paused = null;         // { siteId, frames, memory, site }
    this.enabledSites = new Set();
    this.terminated = false;
    this.memory = null;         // 暂停时的内存快照
    this._configured = false;
    this._status = null;
    this.modId = null;             // 本次会话的 DWARF module id（必须在实例上：同时开两个会话时不能共用）
    this._objRefs = new Map();     // variablesReference -> engine objectId（结构体/STL 展开用）
    this._nextObjRef = 100;
    this.stats = { t0: 0, pauses: 0, sites: 0, files: 0, exit: null };
  }

  /** 求值器报错时的兜底：只支持简单标识符，按作用域里的类型 + 内存快照解码 */
  async _fallbackEvaluate(expr) {
    const name = String(expr || "").trim();
    if (!/^[A-Za-z_]\w*$/.test(name)) return null;
    const s = this.session, p = this.paused;
    if (!s || !p) return null;
    try {
      const vars = await s.engine.listVariablesInScope(this._currentRawLocation());
      const info = (vars || []).find((v) => v.name === name);
      if (!info || !info.type) return null;
      if (!this._isInt128Type(info.type) && !this._isStringType(info.type)) return null;
      const addr = await this._num(`(unsigned)&(${name})`);
      const decoded = this._decodeAt(addr, info.type);
      return decoded ? decoded.value : null;
    } catch {
      return null;
    }
  }

  _refFor(objectId, expr, typeName) {
    if (objectId == null) return 0;
    const id = this._nextObjRef++;
    this._objRefs.set(id, { objectId, expr, typeName });
    return id;
  }
  /** 引擎 evaluate/getProperties 的 remote object → DAP variable
   *  string / __int128 走内存快照解码（引擎求值器认不出这两类） */
  async _toVariable(name, value, fallbackType, expr) {
    const typeName = (value && (value.description || value.type)) || fallbackType || "";
    const e = expr != null ? expr : name;
    if (value && this._isStringType(typeName)) {
      try {
        const addr = await this._num(`(unsigned)&(${e})`);
        const decoded = this._decodeAt(addr, typeName);
        if (decoded) return { name, value: decoded.value, type: typeName, variablesReference: 0 };
      } catch {}
    }
    if (value && this._isInt128Type(typeName)) {
      try {
        const addr = await this._num(`(unsigned)&(${e})`);
        const decoded = this._decodeAt(addr, typeName);
        if (decoded) return { name, value: decoded.value, type: typeName, variablesReference: 0 };
      } catch {}
    }
    const hasKids = !!(value && value.hasChildren && value.objectId != null);
    return {
      name,
      value: formatValue(value),
      type: typeName,
      variablesReference: hasKids ? this._refFor(value.objectId, e, typeName) : 0,
    };
  }

  // ---------------------------------------------------------------- STL 视图
  // 引擎只给 vector 做了格式化器（worker 里的 JS formatter）。set/map/list/
  // unordered_*/priority_queue 我们在这里用「表达式遍历」补：拿节点指针 →
  // 强转成节点类型 → 读 __value_ / __next_ / __right_ 等。
  // 表达式求值走引擎自带的 C++ 求值器（支持 C 风格指针转型，已实测）。
  async _ev(expr) {
    const s = this.session, p = this.paused;
    if (!s || !p) return null;
    return s.engine.evaluate(expr, this._currentRawLocation(), p.stopId);
  }
  async _num(expr) {
    const v = await this._ev(expr);
    const n = v == null ? NaN : (typeof v.value === "number" ? v.value : Number(v.value ?? v.description));
    return Number.isFinite(n) ? n : 0;
  }
  /** 从 allocator 的 rebind_alloc<节点类型> 里抠出完整节点类型名 */
  async _nodeType(allocExpr) {
    let v;
    try { v = await this._ev(allocExpr); } catch { return null; }
    const d = (v && v.description) || "";
    const i = d.indexOf("rebind_alloc<");
    if (i < 0) return null;
    // rebind_alloc<节点类型> 的收尾是 "> >"：只剥掉最外层一个 '>'，内层必须保留
    let t = d.slice(i + "rebind_alloc<".length).trim();
    if (t.endsWith(">")) t = t.slice(0, -1).trim();
    return t || null;
  }
  _mkVar(name, value, type) {
    if (value && typeof value === "object" && value.objectId != null) {
      const hasKids = !!value.hasChildren;
      return {
        name,
        value: formatValue(value),
        type: value.description || type || "",
        variablesReference: hasKids ? this._refFor(value.objectId, name, value.description || type || "") : 0,
      };
    }
    return { name, value: value == null ? "?" : String(value), type: type || "", variablesReference: 0 };
  }

  /** 从 "std::map<int, int, ...>" 这类描述里拆出顶层模板实参 */
  _templateArgs(desc) {
    const i = String(desc).indexOf("<");
    if (i < 0) return [];
    let depth = 0, cur = "", out = [];
    for (let k = i; k < desc.length; k++) {
      const ch = desc[k];
      if (ch === "<") { depth++; if (depth === 1) continue; }
      else if (ch === ">") { depth--; if (depth === 0) { if (cur.trim()) out.push(cur.trim()); break; } }
      else if (ch === "," && depth === 1) { out.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    return out;
  }
  /** 引擎打印的类型名省略了 libc++ 的 inline namespace（std::__hash_node_base），
   *  而求值器需要完整写法（std::__2::__hash_node_base），这里补齐。 */
  _qualify(name) {
    return String(name).replace(/std::__(?!2::)/g, "std::__2::__");
  }
  /** std::string / basic_string<char> 解码（libc++ wasm32 实测布局）：
   *   短串(<=10)：数据在偏移 0，长度在偏移 11（bit7=0）
   *   长串：指针@0，长度@4，偏移 11 的 bit7=1 */
  _readString(addr) {
    const mem = this.memory;
    if (!mem || addr < 0 || addr + 12 > mem.byteLength) return null;
    const b = (o) => mem.u8(addr + o);
    const isLong = (b(11) & 0x80) !== 0;
    if (!isLong) {
      const size = b(11) & 0x7f;
      if (size > 11) return null;
      return new TextDecoder().decode(mem.sub(addr, size));
    }
    const u32 = (o) => mem.dv(addr + o, 4).getUint32(0, true);
    const ptr = u32(0), size = u32(4);
    if (!ptr || size > 1 << 20 || ptr + size > mem.byteLength) return null;
    return new TextDecoder().decode(mem.sub(ptr, size));
  }
  /** __int128 / unsigned __int128（16 字节，小端） */
  _readInt128(addr, signed) {
    const mem = this.memory;
    if (!mem || addr < 0 || addr + 16 > mem.byteLength) return null;
    const dv = mem.dv(addr, 16);
    const lo = dv.getBigUint64(0, true), hi = dv.getBigUint64(8, true);
    let v = (hi << 64n) | lo;
    if (signed && (hi & 0x8000000000000000n)) v -= 1n << 128n;
    return v.toString();
  }
  _isStringType(t) {
    const s = String(t || "").trim().replace(/^const\s+/, "");
    // 注意必须锚定整串：set<std::basic_string<...>> 的模板参数里有 basic_string，但整体不是字符串
    return /^(?:(?:std|std::__2)::)?(?:basic_string\s*<|string$)/.test(s);
  }
  _isInt128Type(t) { return /(^|[\s:])(unsigned )?__int128(\*?)$/.test(String(t).trim()); }
  /** 按类型从内存快照解码一个值（基础类型 / string / __int128） */
  _decodeAt(addr, typeName) {
    const t = String(typeName || "").trim().replace(/^const\s+/, "");
    if (this._isStringType(t)) {
      const s = this._readString(addr);
      return s == null ? null : { kind: "string", value: JSON.stringify(s) };
    }
    if (this._isInt128Type(t)) {
      const s = this._readInt128(addr, !/^unsigned/.test(t));
      return s == null ? null : { kind: "int128", value: s };
    }
    const sz = this._primSize(t);
    if (sz) {
      const v = this._readPrim(addr, t);
      return v == null ? null : { kind: "prim", value: String(v.value) };
    }
    return null;
  }

  /** 从暂停内存快照按基础类型读值（不依赖求值器的类型名） */
  _readPrim(addr, typeName) {
    const mem = this.memory;
    const size = this._primSize(typeName);
    if (!mem || !size || addr < 0 || addr + size > mem.byteLength) return null;
    const dv = mem.dv(addr, size);
    const t = String(typeName).trim();
    let value;
    if (/^(unsigned|bool)/.test(t)) value = size === 1 ? dv.getUint8(0) : size === 2 ? dv.getUint16(0, true) : size === 4 ? dv.getUint32(0, true) : dv.getBigUint64(0, true);
    else if (size === 1) value = dv.getInt8(0);
    else if (size === 2) value = dv.getInt16(0, true);
    else if (size === 4) value = t.includes("float") ? dv.getFloat32(0, true) : dv.getInt32(0, true);
    else value = t.includes("double") ? dv.getFloat64(0, true) : dv.getBigInt64(0, true);
    return { value, size };
  }
  _primSize(t) {
    const m = { "bool": 1, "char": 1, "signed char": 1, "unsigned char": 1, "short": 2, "unsigned short": 2,
      "int": 4, "unsigned": 4, "unsigned int": 4, "signed int": 4, "float": 4, "long": 4, "unsigned long": 4,
      "long long": 8, "unsigned long long": 8, "double": 8, "long double": 8 };
    return m[String(t).trim()] ?? null;
  }
  /** 返回 null 表示"不是我们接管的 STL；走引擎默认展开" */
  async _stlChildren({ expr, typeName }) {
    const t = String(typeName || "");
    try {
      if (/(^|::)priority_queue</.test(t)) return await this._pqChildren(expr);
      if (/(^|::)unordered_(set|multiset|map|multimap)</.test(t)) return await this._hashChildren(expr, t);
      if (/(^|::)(set|multiset|map|multimap)</.test(t)) return await this._treeChildren(expr, /map</.test(t) && !/multiset</.test(t), t);
      if (/(^|::)list</.test(t)) return await this._listChildren(expr, t);
    } catch (e) {
      return [{ name: "（展开失败）", value: String((e && e.message) || e), type: "error", variablesReference: 0 }];
    }
    return null;
  }

  /** map 的一个元素：pair<const K, V>。完整 pair 类型名在求值器里往往不可见，
   *  所以键/值用「基础类型 + 偏移」直接解码；非基础类型给占位提示。 */
  async _mapPairAt(desc, addr, baseSize) {
    const args = this._templateArgs(desc);
    const K = args[0], V = args[1];
    const szK = this._sizeOf(K), szV = this._sizeOf(V);
    if (szK == null || szV == null) {
      return { name: `[0x${Number(addr).toString(16)}]`, value: `（类型 ${K} → ${V} 暂不支持解码）`, type: "info", variablesReference: 0 };
    }
    const offV = Math.ceil(szK / this._alignOf(V)) * this._alignOf(V);
    const k = this._decodeAt(addr + baseSize, K);
    const v = this._decodeAt(addr + baseSize + offV, V);
    return this._mkVar(k ? `[${k.value}]` : `[0x${Number(addr).toString(16)}]`, v ? v.value : "?", `${K} → ${V}`);
  }

  /** 节点指针原始偏移（libc++ wasm32 实测）：
   *  tree: __left_(0) __right_(4) __parent_(8) color(12) → 值偏移 16
   *  list: __prev_(0) __next_(4) → 值偏移 8
   *  hash: __next_(0) __hash_(4) → 值偏移 8 */
  _memU32At(addr, off) { return this._memU32(addr + off); }

  async _treeChildren(expr, isMap, desc) {
    const args = this._templateArgs(desc);
    const K = args[0], V = isMap ? args[1] : null;
    const size = await this._num(`${expr}.__tree_.__size_`);
    const N = Math.min(Math.max(size, 0), 200);
    const VALUE_OFF = 16;
    let addr = await this._num(`(unsigned)${expr}.__tree_.__begin_node_`);
    const out = [];
    for (let i = 0; i < N && addr; i++) {
      if (isMap) out.push(await this._mapPairAt(desc, addr, VALUE_OFF));
      else {
        const d = this._decodeAt(addr + VALUE_OFF, K);
        out.push(this._mkVar(`[${i}]`, d ? d.value : `?（${K}）`, K));
      }
      if (i === N - 1) break;
      const right = this._memU32At(addr, 4);
      if (right) {
        addr = right;
        for (let g = 0; g < 128; g++) {
          const left = this._memU32At(addr, 0);
          if (!left) break;
          addr = left;
        }
      } else {
        let child = addr;
        let up = this._memU32At(addr, 8);
        for (let g = 0; g < 128 && up; g++) {
          if (this._memU32At(up, 4) !== child) break;
          child = up;
          up = this._memU32At(up, 8);
        }
        addr = up;
      }
    }
    if (size > N) out.push({ name: `（还有 ${size - N} 个）`, value: "…", type: "info", variablesReference: 0 });
    return out;
  }

  async _listChildren(expr, desc) {
    const args = this._templateArgs(desc);
    const T = args[0];
    const size = await this._num(`${expr}.__size_`);
    const N = Math.min(Math.max(size, 0), 200);
    let addr = await this._num(`(unsigned)${expr}.__end_.__next_`);
    const out = [];
    for (let i = 0; i < N && addr; i++) {
      const d = this._decodeAt(addr + 8, T);
      out.push(this._mkVar(`[${i}]`, d ? d.value : `?（${T}）`, T));
      addr = this._memU32At(addr, 4);
    }
    if (size > N) out.push({ name: `（还有 ${size - N} 个）`, value: "…", type: "info", variablesReference: 0 });
    return out;
  }

  async _hashChildren(expr, desc) {
    const args = this._templateArgs(desc);
    const isMap = /(^|::)unordered_(multi)?map</.test(desc);
    const K = args[0], V = isMap ? args[1] : null;
    const BASE = 8;                                  // __next_(4) + __hash_(4)
    let addr = await this._num(`(unsigned)${expr}.__table_.__first_node_.__next_`);
    const out = [];
    for (let i = 0; i < 200 && addr; i++) {
      if (isMap) out.push(await this._mapPairAt(desc, addr, BASE));
      else {
        const d = this._decodeAt(addr + BASE, K);
        out.push(this._mkVar(`[${i}]`, d ? d.value : `?（${K}）`, K));
      }
      addr = this._memU32(addr);
    }
    return out;
  }

  /** 读 4 字节无符号（链表 next 指针 / 通用 u32） */
  _memU32(addr) {
    const mem = this.memory;
    if (!mem || addr < 0 || addr + 4 > mem.byteLength) return 0;
    return mem.dv(addr, 4).getUint32(0, true);
  }

  async _pqChildren(expr) {
    // priority_queue 底层是堆序 vector；直接把元素摊开（方便看堆结构），并标出 top()
    const c = await this._ev(`${expr}.c`);
    const out = [];
    if (c && c.objectId != null) {
      let props = [];
      try { props = await this.session.engine.getProperties(c.objectId); } catch {}
      const top = props.length ? formatValue(props[0].value) : "?";
      out.push({ name: "top()（堆顶）", value: top, type: "", variablesReference: 0 });
      props.forEach((p, i) => {
        out.push({
          name: `c[${i}]`,
          value: formatValue(p.value),
          type: (p.value && p.value.description) || "",
          variablesReference: 0,
        });
      });
    } else {
      out.push({ name: "（空）", value: "?", type: "", variablesReference: 0 });
    }
    return out;
  }

  _sizeOf(t) {
    const s = String(t || "").trim().replace(/^const\s+/, "");
    if (this._isStringType(s)) return 12;
    if (this._isInt128Type(s)) return 16;
    return this._primSize(s);
  }
  _alignOf(t) {
    const s = String(t || "").trim().replace(/^const\s+/, "");
    if (this._isStringType(s)) return 4;
    if (this._isInt128Type(s)) return 8;
    const sz = this._primSize(s);
    return sz == null ? 4 : Math.min(sz, 8);
  }

  _term(text) {
    if (!this.terminal) return;
    const s = String(text).replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
    try { this.terminal.write(s); } catch {}
  }
  _statusMsg(text) {
    // 宿主不提供 onStatus 就静默（CLI 宿主不需要状态栏）
    try { this.onStatus?.(String(text)); } catch {}
  }

  dispose() { this._kill(); try { this._emitter.dispose(); } catch {} }

  // ---------------------------------------------------------------- DAP 入口
  // ⚠️ DAP 请求的形状是 { type:"request", command:"launch", ... }：
  //    分发表必须用 command（之前用 msg.type 去找 on_request，导致每个请求都被当成
  //    未知命令回了个空成功 → VS Code 以为 launch 完成、永远等不到 initialized → 卡死）
  handleMessage(msg) {
    if (!msg || msg.type !== "request") return;
    const command = msg.command;
    this.log(`DAP ← ${command}${msg.arguments ? " " + JSON.stringify(msg.arguments).slice(0, 120) : ""}`);
    const fn = this[`on_${command}`];
    if (!fn) { this._respond(msg, undefined); return; }
    Promise.resolve()
      .then(() => fn.call(this, msg))
      .catch((e) => {
        const text = String((e && (e.stack || e.message)) || e);
        this.log(`✗ ${command} 失败: ${text}`);
        this._error(msg, text);
      });
  }

  _send(m) { m.seq = this._seq++; this._emitter.fire(m); }
  _respond(req, body) { this._send({ seq: 0, type: "response", request_seq: req.seq, success: true, command: req.command, body }); }
  _error(req, message) { this._send({ seq: 0, type: "response", request_seq: req.seq, success: false, command: req.command, message }); }
  _event(event, body) { this._send({ seq: 0, type: "event", event, body }); }

  async on_initialize(req) {
    this._respond(req, {
      supportsConfigurationDoneRequest: true,
      supportsEvaluateForHovers: true,
      supportsTerminateRequest: true,
      supportsRestartRequest: false,
      supportsSetVariable: false,
      supportsStepBack: false,
    });
  }

  async on_launch(req) {
    this.stats.t0 = Date.now();
    try {
      return await this._launch(req);
    } catch (e) {
      this._cleanupModule();
      throw e;
    }
  }

  _cleanupModule() {
    try {
      const engine = this._engine || (this.session && this.session.engine);
      if (engine && this.modId) engine.removeRawModule(this.modId).catch(() => {});
    } catch {}
  }

  async _launch(req) {
    this._statusMsg("$(sync~spin) OI C++ 调试：准备中…");
    this._term("\x1b[36m== OI C++ 调试（WASM）==\x1b[0m\r\n");
    this._term(`源文件: ${this.target.fileName}\r\n`);
    this._event("output", { category: "console", output: "正在构建调试版本（-O0 -g，带插桩桩）…\n" });
    await this._prepare();
    this._term("\x1b[36m[4/4] 启动程序…\x1b[0m\r\n");
    this._event("output", { category: "console", output: "调试准备完成，等待断点配置…\n" });
    this._respond(req, {});
    // 告诉 VS Code：可以发断点了
    this._event("initialized", {});
  }

  async on_setBreakpoints(req) {
    const args = req.arguments || {};
    const bps = [];
    const s = this.session;
    const enabled = new Set();
    for (const b of args.breakpoints || []) {
      const line = b.line | 0;                       // DAP 1-based
      const siteIds = s ? this._resolveLine(line) : [];
      if (!siteIds.length) {
        bps.push({ verified: false, line, message: "没有可下断点的语句（空行/注释/头文件/未被行表覆盖）" });
        continue;
      }
      for (const id of siteIds) enabled.add(id);
      bps.push({ verified: true, line });
    }
    this.enabledSites = enabled;
    this._syncBreakpointsToWorker();
    this.log(`断点 ${(args.source && args.source.path) || "?"}: ${bps.filter((x) => x.verified).length}/${bps.length} 已验证`);
    this._respond(req, { breakpoints: bps });
  }

  async on_configurationDone(req) {
    this._configured = true;
    this._respond(req, {});
    await this._startProgram();
  }

  async on_threads(req) { this._respond(req, { threads: [{ id: 1, name: "main (wasm)" }] }); }

  async on_stackTrace(req) {
    const frames = [];
    const p = this.paused;
    const s = this.session;
    if (p && s) {
      const engine = s.engine;
      for (let i = 0; i < p.frames.length; i++) {
        const f = p.frames[i];
        const bodyIdx = f.funcIndex - s.importCount;
        const body = s.bodies[bodyIdx];
        let file = "", line = 0, name = f.name || ("wasm-function[" + f.funcIndex + "]");
        if (body) {
          // 用函数体第一个语句定位（比 V8 的 offset 基准更稳）
          const orig = firstInstrOffset(s.orig, body);
          const locs = await engine.rawLocationToSourceLocation({
            rawModuleId: this.modId, codeOffset: orig - s.codeBase, inlineFrameIndex: 0,
          }).catch(() => null);
          const l0 = (locs || [])[0];
          if (l0) { file = l0.sourceFileURL; line = l0.lineNumber + 1; }
          try {
            const info = await engine.getFunctionInfo({ rawModuleId: this.modId, codeOffset: orig - s.codeBase, inlineFrameIndex: 0 });
            const fname = info && info.frames && info.frames[0] && info.frames[0].name;
            if (fname) name = fname;
          } catch {}
        }
        // 栈顶帧用「暂停点」的精确行号，而不是函数入口行（否则调用栈里显示的行号会偏）
        const site = p.site;
        if (i === 0 && site) { file = site.file; line = site.line; }
        // 只给"用户源文件"挂 source：sysroot 里的 crt1-command.c 之类是 wasisdk: 虚拟路径，
        // 挂上去会让 VS Code 尝试打开它并弹 "Unable to resolve resource wasisdk:..." 错误。
        // ⚠️ 不能用 endsWith 比较原始串：中文文件名下引擎给的是编码形式
        const isUserFile = !!file && sourceBaseName(file) === sourceBaseName(this.target.fileName);
        frames.push({
          id: i + 1, name,
          source: isUserFile
            ? { name: file.split("/").pop(), path: this.target.sourceUri || file }
            : undefined,
          line: isUserFile ? line : 0,
          column: 1,
        });
      }
    }
    this._respond(req, { stackFrames: frames, totalFrames: frames.length });
  }

  async on_scopes(req) {
    const frameId = (req.arguments && req.arguments.frameId) || 1;
    // WASM 只能读"当前帧"的 wasm local（浏览器没有提供读外层帧 local 的 API），
    // 所以外层栈帧给一个说明性 scope，而不是假装有值或直接空白。
    if (frameId !== 1) {
      return this._respond(req, {
        scopes: [{ name: `Locals（第 ${frameId} 帧）`, variablesReference: 2, expensive: false }],
      });
    }
    this._respond(req, { scopes: [{ name: "Locals", variablesReference: 1, expensive: false }] });
  }

  async on_variables(req) {
    // MVP：变量读取依赖 locals/global 快照，目前只保证内存里的变量能被引擎解析；失败就返回空
    try {
      const s = this.session, p = this.paused;
      const ref = req.arguments && req.arguments.variablesReference;
      if (ref === 2) {
        return this._respond(req, {
          variables: [{
            name: "（说明）",
            value: "外层栈帧的局部变量暂不支持：WASM 只允许读当前帧的 local。用「继续」回到该帧后可查看。",
            type: "info",
            variablesReference: 0,
          }],
        });
      }
      if (!s || !p) return this._respond(req, { variables: [] });
      const loc = this._currentRawLocation();

      // 1) 结构体/STL 成员展开
      if (s && this._objRefs.has(ref)) {
        const info = this._objRefs.get(ref);
        const stl = await this._stlChildren(info);
        if (stl) return this._respond(req, { variables: stl });
        const props = await s.engine.getProperties(info.objectId);
        const mapped = [];
        for (const p of props || []) {
          const childExpr = /^\d+$/.test(p.name)
            ? `${info.expr}[${p.name}]`
            : `${info.expr}.${p.name}`;
          mapped.push(await this._toVariable(p.name, p.value, undefined, childExpr));
        }
        return this._respond(req, { variables: mapped });
      }

      // 2) 局部变量
      const rawVars = await s.engine.listVariablesInScope(loc);
      // 过滤标准库内部符号（piecewise_construct / __dso_handle 之类），
      // 它们是引擎把 GLOBAL 也列出来的产物，对用户没意义
      const INTERNAL = /^(std::|__|_GLOBAL__|operator|typeinfo|vtable|__cxa|__wasm)/;
      const vars = (rawVars || []).filter((v) => !INTERNAL.test(String(v.name || "")));
      const out = [];
      for (let i = 0; i < vars.length; i++) {
        const info = vars[i];
        try {
          // ⚠️ 宿主→引擎的 RPC 只暴露 evaluate，没有 getValueInfo（后者只是插件内部方法）
          const vi = await s.engine.evaluate(info.name, loc, p.stopId);
          out.push(await this._toVariable(info.name, vi, info.type, info.name));
        } catch (e) {
          // __int128 之类求值器不支持的类型：用类型信息 + 取地址从内存快照解码
          let decoded = null;
          try {
            if (this._isInt128Type(info.type) || this._isStringType(info.type)) {
              const addr = await this._num(`(unsigned)&(${info.name})`);
              decoded = this._decodeAt(addr, info.type);
            }
          } catch {}
          out.push(decoded
            ? { name: info.name, value: decoded.value, type: info.type, variablesReference: 0 }
            : { name: info.name, value: "<不可用>", type: info.type, variablesReference: 0 });
        }
      }
      this._respond(req, { variables: out });
    } catch (e) {
      this._respond(req, { variables: [] });
    }
  }

  async on_evaluate(req) {
    const args = req.arguments || {};
    const ctx = args.context || "repl";
    const isHover = ctx === "hover";
    try {
      const frameId = args.frameId || 1;
      const s = this.session, p = this.paused;
      if (!s || !p) return this._respond(req, { result: "", variablesReference: 0 });
      if (frameId !== 1) {
        return this._respond(req, {
          result: "外层栈帧暂不支持求值（WASM 只能读当前帧 local）", variablesReference: 0,
        });
      }
      const loc = this._currentRawLocation();
      const expr = String(args.expression || "");
      const vi = await s.engine.evaluate(expr, loc, p.stopId);
      const hasKids = !!(vi && vi.hasChildren && vi.objectId != null);
      this._respond(req, {
        result: formatValue(vi),
        variablesReference: hasKids ? this._refFor(vi.objectId, expr, (vi && vi.description) || "") : 0,
      });
    } catch (e) {
      const msg = String((e && e.message) || e);
      // 引擎求值器不支持 __int128 / string 等类型 → 按变量名查类型后从内存快照解码
      const fallback = await this._fallbackEvaluate(String(args.expression || ""));
      if (fallback != null) {
        return this._respond(req, { result: fallback, variablesReference: 0 });
      }
      if (isHover) return this._respond(req, { result: "", variablesReference: 0 });
      // 把引擎的 EvalError 前缀剥掉，只留诊断本身（调试控制台里更好读）
      const short = msg.replace(/^EvalError: /, "").replace(/<expr>:\d+:\d+: /, "");
      this._respond(req, { result: "错误: " + short, variablesReference: 0 });
    }
  }

  async on_continue(req) { this._resume(req, 1); }
  async on_next(req) { this._resume(req, 3); }
  async on_stepIn(req) { this._resume(req, 2); }
  async on_stepOut(req) { this._resume(req, 4); }
  async on_pause(req) {
    // 运行期主动暂停：下次探针命中即停（把模式设成"任意语句"）
    if (this.worker) this.worker.postMessage({ type: "resume", mode: 2 });
    this._respond(req, {});
  }
  async on_disconnect(req) { this._kill(); this._respond(req, {}); this._event("terminated", {}); }
  async on_terminate(req) { this._kill(); this._respond(req, {}); this._event("terminated", {}); }

  // ---------------------------------------------------------------- 内部
  _resume(req, mode) {
    if (!this.worker || !this.ctrl) { this._respond(req, {}); return; }
    this._lastMode = mode;
    this.paused = null;
    this._event("continued", { threadId: 1, allThreadsContinued: true });
    this._statusMsg("$(debug-alt) OI C++ 调试：运行中");
    // ⚠️ 必须由宿主直接写 SAB：worker 正在 Atomics.wait，收不到 postMessage
    Atomics.store(this.ctrl, 1, mode);
    Atomics.store(this.ctrl, 0, 1);
    Atomics.notify(this.ctrl, 0);
    this._respond(req, { allThreadsContinued: true });
  }

  _assertAlive() {
    if (this.terminated) throw new Error("调试会话已结束（准备过程被中止）");
  }

  async _prepare() {
    const t0 = Date.now();
    // 唯一 ID：同一毫秒内重复点击调试也不能撞（引擎对重复 module id 会报 InternalError）
    this.modId = `oi-debug-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.log("① 开始编译调试版本…");
    this._term("[1/4] 编译调试版本（-O0 -g + 插桩桩）…\r\n");
    const tCompile = Date.now();
    const r = await this.compile({ source: this.target.source, fileName: this.target.fileName, flags: this.target.flags, opt: 0, debugInfo: true, debugStub: true });
    this.log("① 编译完成 " + ((r && r.wasm) ? (r.wasm.byteLength / 1024).toFixed(0) + "KB" : "失败"));
    if (!r || !r.wasm) {
      this._term("\x1b[31m      编译失败\x1b[0m\r\n");
      throw new Error("调试构建失败: " + String((r && r.log) || "").split("\n").slice(0, 6).join(" | "));
    }
    this._term(`      \x1b[32m✓\x1b[0m ${(r.wasm.byteLength / 1024).toFixed(0)}KB，${Date.now() - tCompile}ms\r\n`);
    this._assertAlive();
    const orig = new Uint8Array(r.wasm);
    this.log("② 取 DWARF 引擎…");
    this._term("[2/4] 启动 DWARF 符号引擎（首次约 12.7MB）…\r\n");
    const tEngine = Date.now();
    const engine = await this.getEngine();
    this._engine = engine;
    this._assertAlive();
    this.log("② 引擎就绪");
    this._term(`      \x1b[32m✓\x1b[0m 就绪，${Date.now() - tEngine}ms\r\n`);
    const info = parseWasm(orig);
    if (info.probeImportIndex < 0) throw new Error("调试构建缺少 oi.probe import（桩没链上）");
    const codeBase = info.code.contentStart;
    const importCount = info.funcImports.length;

    // 只给"用户工作区文件"生成语句站点（避免把 165 个头文件全插桩：体积/速度都吃不消）
    const wasmUrl = "file:///workspace/" + this.target.fileName;
    this.log(`③ addRawModule…（url=${wasmUrl}，code=${r.wasm ? (r.wasm.byteLength / 1024).toFixed(0) + "KB" : "无"}）`);
    this._term("[3/4] 解析 DWARF 符号…\r\n");
    let sources;
    try {
      sources = await engine.addRawModule(this.modId, wasmUrl, r.wasm);
    } catch (e) {
      // 引擎内部错误的可见性：把上下文拼进错误消息（URL 相关的异常尤其需要）
      throw new Error(`addRawModule 失败（url=${wasmUrl}）: ${(e && e.message) || e}`);
    }
    this._assertAlive();
    this.log("③ 源文件 " + ((sources && sources.length) || 0) + " 个");
    this._term(`      \x1b[32m✓\x1b[0m 源文件 ${(sources || []).length} 个\r\n`);
    const userFiles = (sources || []).filter((u) => /^file:\/\/\/workspace\//.test(normalizeSourceUrl(u)));
    const sites = [];
    const siteByLine = new Map();   // `${file}:${line0}` -> [siteId]
    let nextId = 1;
    for (const file of userFiles) {
      let lines = [];
      try { lines = (await engine.getMappedLines(this.modId, file)) || []; } catch { lines = []; }
      for (const line0 of lines) {
        // ⚠️ 踩坑：不要为了"按语句切分"把每行的列全扫一遍。
        //    每列一次引擎 RPC，几十行的文件就是几千次往返，准备阶段被拖死
        //    → 断点来不及设上 → 表现为"断点基本不管用"。
        //    正确做法：每行只取第一个命中列（上面这行 break 就是关键）。
        // 每行只取**第一个**能映射到 wasm 的偏移（列扫描命中即停）。
        // ⚠️ 不要扫完所有列：那会让每行产生几十次引擎 RPC，几十行的文件就要
        //    几千次往返，准备阶段被拖死 → 断点设不上、调试感觉"废了"。
        let rangeStart = null;
        for (let col = 0; col <= 200 && rangeStart == null; col++) {
          const rs = await engine.sourceLocationToRawLocation({
            rawModuleId: this.modId, sourceFileURL: file, lineNumber: line0, columnNumber: col,
          }).catch(() => null);
          if (rs && rs.length) rangeStart = rs[0].startOffset;
        }
        if (rangeStart == null) continue;
        {
          const origOffset = codeBase + rangeStart;
          const bodyIdx = info.code.bodies.findIndex((b) => origOffset >= b.bodyStart && origOffset < b.end);
          if (bodyIdx < 0) continue;
          const id = nextId++;
          sites.push({ id, line: line0 + 1, file, body: bodyIdx, origOffset });
          const key = `${normalizeSourceUrl(file)}:${line0}`;
          if (!siteByLine.has(key)) siteByLine.set(key, []);
          siteByLine.get(key).push(id);
        }
      }
    }
    this.log(`④ 语句站点 ${sites.length} 个`);
    if (!sites.length) throw new Error("没有生成任何语句站点（DWARF 行表为空？）");
    this._term(`      \x1b[32m✓\x1b[0m 可断点语句 ${sites.length} 个（用户文件 ${userFiles.length} 个）\r\n`);

    // fileOfInterest：按"解码后的文件名"在引擎给的源文件里找，找不到就退化为唯一用户文件
    const wantName = sourceBaseName(this.target.fileName);
    const fileOfInterest = userFiles.find((u) => sourceBaseName(u) === wantName)
      || (userFiles.length === 1 ? userFiles[0] : null)
      || ("file:///workspace/" + this.target.fileName);
    this.log(`④ 用户源文件 ${JSON.stringify(userFiles)} → 命中 ${fileOfInterest}`);

    const instr = instrumentWasm(orig, sites.map((s) => ({ id: s.id, offset: s.origOffset })));
    if (instr.dropped && instr.dropped.length) this.log(`插桩丢弃 ${instr.dropped.length} 个点`);
    this.session = {
      engine, orig, instr, sites, siteByLine, codeBase, importCount,
      bodies: info.code.bodies,
      // ⚠️ 必须用引擎返回的原始串（可能 percent-encoded），不能用我们自己拼的：
      //    否则中文文件名下 siteByLine 查不到（断点全灰）
      fileOfInterest: fileOfInterest,
      fileName: this.target.fileName,
      siteById: new Map(sites.map((s) => [s.id, s])),
      siteIdToBody: new Map(sites.map((s) => [s.id, s.body])),
      bodyLocals: instr.bodyLocals || [],
      globalTypes: instr.globalTypes || [],
    };
    this._assertAlive();
    this.stats.sites = sites.length;
    this.stats.files = userFiles.length;
    this.log(`调试准备完成：${sites.length} 个语句站点 / ${userFiles.length} 个用户文件 / ${Date.now() - t0}ms`);
  }

  /** DAP 1-based line → 该行（或邻近声明行）的 siteId 列表 */
  _resolveLine(line1) {
    const s = this.session;
    if (!s) return [];
    const line0 = line1 - 1;
    const tryLines = [line0, line0 + 1, line0 + 2, line0 + 3];
    for (const l of tryLines) {
      const ids = s.siteByLine.get(`${normalizeSourceUrl(s.fileOfInterest)}:${l}`);
      if (ids && ids.length) return ids;
    }
    return [];
  }
  _linesOfSite(id) {
    const s = this.session;
    const site = s && s.siteById.get(id);
    return site ? [site.line] : [];
  }

  _currentRawLocation() {
    const s = this.session, p = this.paused;
    const site = p && s && s.siteById.get(p.siteId);
    const origOffset = site ? site.origOffset : 0;
    return { rawModuleId: this.modId, codeOffset: origOffset - (s ? s.codeBase : 0), inlineFrameIndex: 0 };
  }

  _syncBreakpointsToWorker() {
    if (!this.bp) return;
    this.bp.fill(0);
    for (const id of this.enabledSites) {
      const w = id >>> 5, m = 1 << (id & 31);
      Atomics.store(this.bp, w, Atomics.load(this.bp, w) | m);
    }
  }

  async _startProgram() {
    const s = this.session;
    if (!s) { this._event("terminated", {}); return; }
    this.sab = new SharedArrayBuffer(8);
    this.ctrl = new Int32Array(this.sab);
    // 断点位图（按最大 siteId 分配；宿主可随时改，worker 无需收消息）
    const words = Math.ceil(Math.max(1, ...s.sites.map((x) => x.id)) / 32) + 1;
    this.bpSab = new SharedArrayBuffer(words * 4);
    this.bp = new Int32Array(this.bpSab);
    this._syncBreakpointsToWorker();

    // stdin：真终端输入（协议与 runWorker 完全一致）
    this.stdinSab = new SharedArrayBuffer(8 + 65536);
    this.stdinCtrl = new Int32Array(this.stdinSab, 0, 2);
    this.stdinBuf = new Uint8Array(this.stdinSab, 8);
    this._inputQueue = [];
    if (this.terminal && typeof this.terminal.onInput === "function") {
      this.terminal.onInput((bytes) => this._queueInput(bytes));
    }
    if (this.terminal && typeof this.terminal.onEof === "function") {
      // Ctrl+D：把 EOF 写进 stdin 单槽（state=3），程序的下一次 read 会立刻拿到 EOF
      this.terminal.onEof(() => {
        if (!this.stdinCtrl) return;
        Atomics.store(this.stdinCtrl, 0, 3);
        Atomics.notify(this.stdinCtrl, 0);
      });
    }

    this.log(`启动调试运行 worker（${s.sites.length} 个站点，断点 ${this.enabledSites.size} 个）`);
    this._term("程序即将运行。\r\n\x1b[90m· 输入直接在本终端键入（和平时运行一样）\r\n· 命中断点会在左侧停住，可看调用栈/单步\r\n· 停止会话请按调试工具条的 ⏹ 或 Ctrl+Shift+F5\x1b[0m\r\n\r\n");
    // 把焦点切到这个终端：否则用户会在"调试控制台"里输入（那里是 REPL，不喂 stdin）
    try { this.terminal?.show?.(); } catch {}
    // ⚠️ 用 createWorker：跨源 CDN / 桌面 VS Code 的 vscode-file:// 下 new Worker(url) 会被拦
    this.worker = await createWorker(this.workerUrl, { log: (m) => this.log("[wdb] " + m) });
    this.worker.onmessage = (ev) => this._onWorkerMessage(ev.data);
    this.worker.onerror = (e) => { this._error2("debug worker 崩溃: " + ((e && e.message) || e)); };
    this.worker.postMessage({
      type: "init",
      wasm: s.instr.wasm.buffer,
      sites: s.sites,
      breakpointSab: this.bpSab,
      sab: this.sab,
      stdinSAB: this.stdinSab,
      bodyLocals: s.bodyLocals || [],
      globalTypes: s.globalTypes || [],
      fileName: s.fileName,
    }, [s.instr.wasm.buffer]);
    // 注意：instr.wasm 的 buffer 被转移走了，后面不要再读它
    s.instr = null;
  }

  /** 终端输入：宿主只能在 state===0（worker 空闲）时写单槽，其余排队等 consumed */
  _queueInput(bytes) {
    if (!bytes || !bytes.length) return;
    this._inputQueue.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    this._flushInput();
  }
  _flushInput() {
    const ctrl = this.stdinCtrl, buf = this.stdinBuf;
    if (!ctrl || !buf) return;
    while (this._inputQueue.length) {
      if (Atomics.load(ctrl, 0) !== 0) return;      // worker 侧还没取走上一批
      const chunk = this._inputQueue.shift();
      const n = Math.min(chunk.length, buf.length);
      buf.set(chunk.subarray(0, n), 0);
      if (n < chunk.length) this._inputQueue.unshift(chunk.subarray(n));
      Atomics.store(ctrl, 1, n);
      Atomics.store(ctrl, 0, 1);
      Atomics.notify(ctrl, 0);
      return;
    }
  }

  _onWorkerMessage(m) {
    if (!m || typeof m !== "object") return;
    if (m.type === "consumed") { this._flushInput(); return; }
    if (m.type === "stdout" || m.type === "stderr") {
      this._event("output", { category: m.type === "stderr" ? "stderr" : "stdout", output: m.text });
      this._term(m.text);                                   // 程序输出进真终端
      return;
    }
    if (m.type === "started") {
      this._statusMsg("$(debug-alt) OI C++ 调试：运行中");
      this._event("process", { name: "wasm program", isLocalProcess: true, systemProcessId: 0, startMethod: "launch" });
      return;
    }
    if (m.type === "error") { this._error2(m.message); return; }
    if (m.type === "exit") {
      const code = m.code || 0;
      const ms = this.stats.t0 ? Date.now() - this.stats.t0 : 0;
      const sec = (ms / 1000).toFixed(1);
      const color = code === 0 ? "32" : "31";
      this._term(`\r\n\x1b[${color}m[程序${code === 0 ? "正常退出" : "异常退出"} code=${code}]\x1b[0m 总用时 ${sec}s，暂停 ${this.stats.pauses} 次，可断点语句 ${this.stats.sites} 个\r\n`);
      this._term("\x1b[90m[调试会话结束] 关掉这个终端不会影响代码；再点 🐞 会重新编译。\x1b[0m\r\n");
      this._status?.dispose(); this._status = null;
      this._event("exited", { exitCode: code });
      this._event("terminated", {});
      this._kill();
      return;
    }
    if (m.type === "paused") {
      this.paused = {
        siteId: m.siteId, site: m.site, frames: m.frames || [], memory: m.memory, stopId: { siteId: m.siteId },
        localsBase: m.localsBase || 0, bodyLocals: m.bodyLocals || [],
      };
      this.memory = m.memorySegments
        ? new SparseMem(m.memorySize || 0, m.memorySegments)
        : (m.memory ? new SparseMem(m.memory.byteLength, [{ offset: 0, bytes: m.memory }]) : EMPTY_MEM);
      this.onSnapshot(this.memory);   // 内存快照给引擎读变量
      this.onFrame?.({
        base: this.paused.localsBase, types: this.paused.bodyLocals,
        globalsBase: m.globalsBase, globalTypes: m.globalTypes || [],
      });
      this.stats.pauses++;
      const site = m.site;
      const where = site ? `${site.file.split("/").pop()}:${site.line}` : "?";
      this.log(`⏸ 暂停 site=${m.siteId} ${where}（栈 ${this.paused.frames.length} 帧，内存 ${(this.memory.byteLength / 1048576).toFixed(1)}MB，快照拷贝 ${(this.memory.bytesCopied / 1048576).toFixed(1)}MB）`);
      this._term(`\r\n\x1b[33m[暂停] ${where}（第 ${this.stats.pauses} 次）\x1b[0m\r\n`);
      this._statusMsg(`$(debug-pause) OI C++ 调试：已暂停 ${where}`);
      this._event("stopped", {
        reason: (this._lastMode && this._lastMode !== 1) ? "step" : "breakpoint",
        threadId: 1,
        allThreadsStopped: true,
        text: where,
        description: `暂停在 ${site ? site.file + ":" + site.line : "?"}`,
      });
    }
  }

  _error2(message) {
    this.log("✗ " + String(message));
    this._term(`\r\n\x1b[31m[调试失败] ${String(message)}\x1b[0m\r\n`);
    this._status?.dispose(); this._status = null;
    this._event("output", { category: "stderr", output: String(message) + "\n" });
    this._event("terminated", {});
    this._kill();
  }

  _kill() {
    if (this.terminated) return;
    this.terminated = true;
    try {
      if (this.session && this.session.engine) {
        for (const info of this._objRefs.values()) {
          try { this.session.engine.releaseObject(info.objectId).catch(() => {}); } catch {}
        }
        this.session.engine.removeRawModule(this.modId).catch(() => {});
      }
    } catch {}
    this._objRefs.clear();
    if (this.worker) { try { this.worker.postMessage({ type: "shutdown" }); } catch {} try { this.worker.terminate(); } catch {} this.worker = null; }
    this.paused = null;
    this.memory = null;
    try { this._status?.dispose(); } catch {}
    this._status = null;
    this.modId = null;
  }

  // ---- 供宿主（extension.js）注入：DWARF 引擎的宿主 getter 需要读暂停快照 ----
  getLinearMemorySnapshot() { return this.memory; }
}
