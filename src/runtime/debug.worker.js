// 调试运行 worker（经典 worker）：
//   运行【已插桩】的 wasm，通过 import "wdb"."probe" 在语句起点回调；
//   命中"应暂停"的条件时：抓取调用栈 + 线性内存快照 → 通知宿主 → Atomics.wait 阻塞，等宿主恢复。
//
// 与宿主的控制协议（SharedArrayBuffer，Int32Array）：
//   ctrl[0] = 0（worker 正在等）/ 1（宿主已恢复）
//   ctrl[1] = 恢复模式：1=continue(只停断点) 2=stepIn(任意语句) 3=stepOver(同函数) 4=stepOut(离开当前函数)
import { WASI, File, OpenFile, ConsoleStdout, Fd } from "@bjorn3/browser_wasi_shim";

const post = (m, transfer) => self.postMessage(m, transfer || []);

// stdin 协议与 runWorker.js 完全一致：
//   ctrl[0] state: 0=空闲(宿主可写) 1=有数据(worker 可取) 3=EOF；ctrl[1] len；data 从偏移 8 开始
/** 终端 stdin：单槽握手 + _justServed（防止一次 fd_read 的第二个 iovec 假 EOF） */
/** trap 重放用的"回放 stdin"：把录制下来的字节按顺序吐出（读空即 EOF 语义） */
class ReplayStdin extends Fd {
  constructor(bytes) { super(); this.bytes = bytes; this.pos = 0; }
  fd_fdstat_get() {
    return { ret: 0, fdstat: { fs_filetype: 2, fs_flags: 0, fs_rights_base: 0xffffffffn, fs_rights_inheriting: 0xffffffffn } };
  }
  fd_read(size) {
    const n = Math.min(size, this.bytes.length - this.pos);
    if (n <= 0) return { ret: 0, data: new Uint8Array(0) };
    const data = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return { ret: 0, data };
  }
}

class TermStdin extends Fd {
  constructor(sab) {
    super();
    this.ctrl = new Int32Array(sab, 0, 2);
    this.buf = new Uint8Array(sab, 8);
    this._justServed = false;
  }
  fd_fdstat_get() {
    return { ret: 0, fdstat: { fs_filetype: 2, fs_flags: 0, fs_rights_base: 0xffffffffn, fs_rights_inheriting: 0xffffffffn } };
  }
  resetJustServed() { this._justServed = false; }
  fd_read(size) {
    for (;;) {
      const st = Atomics.load(this.ctrl, 0);
      if (st === 3) { this._justServed = false; return { ret: 0, data: new Uint8Array(0) }; }
      if (st === 1) {
        const len = Atomics.load(this.ctrl, 1);
        const n = Math.min(size, len);
        const data = this.buf.slice(0, n);
        const rest = len - n;
        if (rest > 0) this.buf.copyWithin(0, n, len);
        Atomics.store(this.ctrl, 1, rest);
        Atomics.store(this.ctrl, 0, rest > 0 ? 1 : 0);
        Atomics.notify(this.ctrl, 0);
        post({ type: "consumed" });          // 让宿主继续冲刷输入队列
        this._justServed = true;
        if (stdinRecordLen < STDIN_RECORD_CAP) { stdinRecord.push(data.slice(0)); stdinRecordLen += data.length; }
        return { ret: 0, data };
      }
      // 同一次 syscall 的第二个 iovec：已交付过就不能再阻塞等新输入
      if (this._justServed) { this._justServed = false; return { ret: 0, data: new Uint8Array(0) }; }
      // 等用户输入是正常状态（页面/终端关闭会 terminate worker）
      Atomics.wait(this.ctrl, 0, 0, 30000);
    }
  }
}

let cfg = null;
let siteById = new Map();      // siteId -> { id, line, file, body, origOffset }
let bp = null;                 // 断点位图（Int32Array on SharedArrayBuffer）：宿主可随时改，无需消息
let ctrl = null;               // Int32Array(SAB)
let inst = null;
let resumeMode = 1;
let stopDepth = 0;      // 暂停时的栈帧数（stepOut 用来判断是否已返回调用者）
let stopBody = -1;             // 最近一次暂停所在的函数体（stepOver/stepOut 用）
let stopLine = -1;             // 最近一次暂停的行号（单步按行前进，避免同一条语句反复停）
let running = false;
let pending = null;            // probe 判定要暂停后暂存的站点（等 pause() 真正停）
let lastSite = null;           // 最后经过的语句站点（trap 时用它近似定位崩溃行）
let trapped = null;            // 已因 trap 暂停（之后不再继续执行）
// ---- trap 影子重放（拿到完整调用栈 + 崩溃瞬间的变量）----
const stdinRecord = [];        // 录下的 stdin 字节块（交互输入也能重放）
let stdinRecordLen = 0;
const STDIN_RECORD_CAP = 16 * 1024 * 1024;
const replay = { active: false, target: 0, budget: 0, hit: false };
let scratchBase = 0;           // locals 快照区（memory.grow 出来的那一页）
let bodyLocals = [];           // 每个函数体的 local 类型表（来自插桩）
let globalTypes = [];          // 全局变量类型表（插桩时按 wasm global 索引顺序）

/** 从 JS 栈里提取 wasm 帧（V8：at name (wasm-function[12]:0x1a5)） */
function captureStack() {
  const frames = [];
  const lines = String(new Error().stack || "").split("\n");
  for (const line of lines) {
    const m = /wasm-function\[(\d+)\]:0x([0-9a-f]+)/i.exec(line);
    if (!m) continue;
    const nm = /^\s*at\s+(?:([^\s(]+)\s*\()?/.exec(line);
    frames.push({
      funcIndex: Number(m[1]),
      offset: parseInt(m[2], 16),
      name: nm && nm[1] ? nm[1].split(".").pop() : "",
    });
  }
  return frames;
}

/** 探针：判断是否需要暂停；需要则返回 locals 快照地址（0 = 不暂停） */
let depthTick = 0;
const DEPTH_CHECK_EVERY = 16;   // 每 16 个候选点才算一次栈深度（限流，兼顾精度与开销）
function depthThrottled() {
  if ((++depthTick % DEPTH_CHECK_EVERY) !== 0) return false;
  return true;
}
// 只在限流通过时才算（captureStack 会 new Error().stack，不便宜）
function stackDepth() { try { return captureStack().length; } catch { return stopDepth; } }

function probe(siteId) {
  const site = siteById.get(siteId);
  if (!site) return 0;
  lastSite = site;                 // 廉价：trap 时用它说明"崩溃前最后一句在哪"
  // ---- 重放模式：只关心"是否到达目标站点"，不看断点/单步 ----
  if (replay.active) {
    if (replay.budget-- <= 0) throw new Error("__oi_replay_abort");
    if (siteId !== replay.target) return 0;
    // 到达目标：照常准备 locals 快照区，交给 pause() 上报
    if (!scratchBase) {
      try { const old = inst.exports.memory.buffer.byteLength; inst.exports.memory.grow(1); scratchBase = old; } catch { scratchBase = 0; }
    }
    pending = site;
    replay.hit = true;
    return scratchBase;
  }
  // 别名组：多个源码语句的栈空回退点可能撞到同一插桩位置，
  // 任意一个别名 id 命中断点都算命中
  const ids = [siteId, ...(site.aliases || [])];
  const isBreakpoint = !!bp && ids.some((id) => (Atomics.load(bp, id >>> 5) & (1 << (id & 31))) !== 0);
  // ⚠️ 单步语义对齐 gdb（这里以前有三处与 gdb 不符）：
  //   · next(3)：只停在本函数体的下一条语句，但**函数里的断点仍然要命中**
  //     （以前直接忽略断点 → 调用的函数里有断点也不停）
  //   · stepOut(4)：要"回到调用者栈帧"才停。以前用"函数体不同"判断，
  //     于是同一个函数被再次调用时会误停（表现为"出来后又回到这个函数第一行"）
  //   · stepIn(2)：停在任意位置的下一条语句；断点同样优先
  // 栈深度用 captureStack() 数帧；为了不给每个语句都付代价，
  // 只在 stepOut 的候选点上才算深度。
  const sameLine = resumeMode !== 1 && site.line === stopLine;
  let hit = false;
  if (isBreakpoint) {
    hit = true;                                   // 断点永远优先（任何模式下）
  } else if (resumeMode === 2) {
    hit = !sameLine;                              // step in
  } else if (resumeMode === 3) {
    if (!sameLine) {
      if (site.body === stopBody) hit = true;                          // 同帧下一条语句
      else hit = depthThrottled() && stackDepth() < stopDepth;          // 已返回调用者（函数末行 next ≈ finish）
    }
  } else if (resumeMode === 4) {
    if (!sameLine && site.body !== stopBody) {
      hit = depthThrottled() && stackDepth() < stopDepth;               // step out：真正回到更浅的帧
    }
  }
  if (!hit) return 0;

  // locals 快照区：第一次暂停时 grow 一页并复用（不碰堆/栈）
  if (!scratchBase) {
    try {
      const old = inst.exports.memory.buffer.byteLength;
      inst.exports.memory.grow(1);
      scratchBase = old;
    } catch (e) {
      scratchBase = 0;
    }
  }
  // 命中的可能是"别名站点"（多个语句共用同一探针）：此时上报用户下断点的那一行，
  // 但函数体沿用真正执行的位置（locals 快照区/栈帧统计都按它算）。
  let report = site;
  if (isBreakpoint) {
    const markId = ids.find((id) => (Atomics.load(bp, id >>> 5) & (1 << (id & 31))) !== 0);
    const rep = markId != null ? siteById.get(markId) : null;
    if (rep && rep.id !== site.id) report = { ...rep, body: site.body };
  }
  pending = report;
  return scratchBase;
}

/** pause：locals 已写入快照区，这里抓栈 + 内存快照并阻塞等宿主恢复 */
function pause() {
  const site = pending;
  pending = null;
  if (!site) return;

  const frames = captureStack();
  const snap = snapshotMemory(site);
  if (replay.active) {
    post({
      type: "trap", replayed: true, reason: trapped && trapped.reason, message: trapped && trapped.message,
      site, siteId: site.id, frames,
      memorySegments: snap.memorySegments, memorySize: snap.memorySize,
      localsBase: scratchBase, body: site.body,
      bodyLocals: bodyLocals[site.body] || [],
      globalsBase: scratchBase + (bodyLocals[site.body] || []).length * 8,
      globalTypes,
    });
    Atomics.wait(ctrl, 0, 0);
    try { Atomics.store(ctrl, 0, 0); } catch {}
    return;
  }
  post({
    type: "paused", siteId: site.id, site, frames,
    memorySegments: snap.memorySegments, memorySize: snap.memorySize,
    localsBase: scratchBase, body: site.body,
    bodyLocals: bodyLocals[site.body] || [],
    globalsBase: scratchBase + (bodyLocals[site.body] || []).length * 8,
    globalTypes,
  });

  Atomics.wait(ctrl, 0, 0);
  const mode = Atomics.load(ctrl, 1) || 1;
  resumeMode = mode;
  stopBody = site.body;
  stopLine = site.line;
  stopDepth = frames.length;      // stepOut 用它判断"是否已返回到调用者"
  Atomics.store(ctrl, 0, 0);
}

/** 分段内存快照（低区 + 实际用到的栈；512MB 栈不能整块拷） */
function snapshotMemory(site) {
  // ---- 分段内存快照 ----
  // ⚠️ 必须分段：调试栈 512MB，整块拷贝会让每次暂停卡死（详见 mem-view.mjs 注释）。
  //    栈区起点用 __stack_pointer（wasi-sdk 输出里是全局 0）反推，
  //    拿不到 sp 时退化为"最后 8MB"，宁可少拷也别炸。
  // 调试栈开得很大（512MB），整块拷贝会让每次暂停卡死；这里只拷贝真正有用的区域：
  //   低区：静态数据 + 堆（__heap_base 起向上分配，最多 LOW_CAP）
  //   栈区：当前 __stack_pointer 到内存末尾（= 实际用掉的栈 + 极小的顶部余量）
  let memorySegments = null;
  let memorySize = 0;
  const LOW_CAP = 16 * 1024 * 1024;
  try {
    const buf = inst && inst.exports && inst.exports.memory && inst.exports.memory.buffer;
    if (buf) {
      memorySize = buf.byteLength;
      // __stack_pointer：wasi-sdk 输出里是全局 0（i32，可变）
      let sp = 0;
      try {
        const globalsOff = scratchBase + (bodyLocals[site.body] || []).length * 8;
        sp = new Int32Array(buf, globalsOff, 1)[0] >>> 0;
      } catch { sp = 0; }
      const PAGE = 65536;
      const stackLow = sp > 0
        ? Math.min(memorySize, Math.max(LOW_CAP, ((sp - PAGE) & ~(PAGE - 1)) >>> 0))
        : Math.max(0, memorySize - 8 * 1024 * 1024);   // 拿不到 sp 时保守拷最后 8MB（栈区）
      const segs = [];
      const lowEnd = Math.min(LOW_CAP, stackLow, memorySize);
      if (lowEnd > 0) segs.push({ offset: 0, bytes: new Uint8Array(buf, 0, lowEnd).slice(0) });
      if (stackLow < memorySize) {
        segs.push({ offset: stackLow, bytes: new Uint8Array(buf, stackLow, memorySize - stackLow).slice(0) });
      }
      memorySegments = segs;
    }
  } catch { memorySegments = null; }
  return { memorySegments, memorySize };
}

async function run() {
  running = true;
  // stdin：有 SAB 就接终端（交互输入）；没有则给"读即 EOF"的真 fd
  const stdin = cfg.stdinSAB ? new TermStdin(cfg.stdinSAB) : null;
  const fds = [
    stdin ?? new OpenFile(new File(new Uint8Array(0))),
    new ConsoleStdout((b) => post({ type: "stdout", text: decode(b) })),
    new ConsoleStdout((b) => post({ type: "stderr", text: decode(b) })),
  ];
  const wasi = new WASI([cfg.fileName || "program"], [], fds);
  // 一次 fd_read syscall 内的多个 iovec 共享 _justServed，出 syscall 复位（同 runWorker）
  if (stdin) {
    const origFdRead = wasi.wasiImport.fd_read;
    wasi.wasiImport.fd_read = (...args) => {
      try { return origFdRead(...args); }
      finally { try { stdin.resetJustServed(); } catch {} }
    };
  }
  let mod;
  try {
    mod = await WebAssembly.compile(cfg.wasm);
  } catch (e) {
    post({ type: "error", message: "插桩后的 wasm 无法编译: " + ((e && e.message) || e) });
    return;
  }
  try {
    inst = await WebAssembly.instantiate(mod, {
      wasi_snapshot_preview1: wasi.wasiImport,
      wdb: { probe, pause },
    });
  } catch (e) {
    post({ type: "error", message: "实例化失败: " + ((e && e.message) || e) });
    return;
  }
  post({ type: "started" });
  let code = 0;
  try {
    code = wasi.start(inst) ?? 0;
  } catch (e) {
    if (e && typeof e.code === "number") code = e.code;
    else if (e && e.name === "WASIProcExit") code = e.code ?? 0;
    else if (isTrap(e)) {
      const msg = String((e && (e.message || e)) || e);
      trapped = { reason: msg, message: msg, site: lastSite };
      // 先在"影子实例"里重放到崩溃前那一句 → 拿到完整调用栈 + 当时的变量
      const ok = await replayToTrap(mod);
      if (!ok) {
        reportTrap(e);
        // 崩溃后不要立刻 exit：像普通暂停一样阻塞，等宿主"停止会话"再结束，
        // 否则 UI 上会一闪而过（stopped → terminated）。
        try { Atomics.wait(ctrl, 0, 0); } catch {}
      }
      code = -1;
    }
    else post({ type: "error", message: "运行异常: " + ((e && (e.stack || e.message)) || e) });
  }
  running = false;
  post({ type: "exit", code });
}

// ---------------- trap（wasm 崩溃）----------------
// 越界 / unreachable / 除零 / 栈溢出 等会直接抛 WebAssembly.RuntimeError，
// 以前只回一个 "exit code"，用户看不到在哪炸的。这里抓下来当"异常暂停"上报。
const TRAP_RE = /unreachable|out of bounds|divide by zero|remainder by zero|call stack|stack overflow|invalid conversion|invalid value|signature mismatch|table index|indirect call|null function|integer overflow|undefined element/i;
function isTrap(e) {
  if (!e) return false;
  if (typeof WebAssembly !== "undefined" && e instanceof WebAssembly.RuntimeError) return true;
  return TRAP_RE.test(String((e && e.message) || e));
}
/**
 * 影子实例重放：用同一份 wasm + 录制的 stdin 重跑，停在"崩溃前最后那一句"。
 * 成功时 pause() 会直接上报 {type:"trap", replayed:true, frames, locals…} 并阻塞等宿主。
 * 失败（没有站点 / 到不了目标 / 预算超限 / 需要更多输入）返回 false，调用方退回简版上报。
 */
async function replayToTrap(mod) {
  const site = lastSite;
  if (!site) return false;
  replay.active = true; replay.target = site.id; replay.budget = 2_000_000; replay.hit = false;
  const prevInst = inst, prevPending = pending, prevScratch = scratchBase;
  scratchBase = 0; pending = null;
  try {
    const all = new Uint8Array(stdinRecordLen);
    let off = 0;
    for (const c of stdinRecord) { all.set(c, off); off += c.length; }
    const fds = [
      new ReplayStdin(all),
      new ConsoleStdout(() => {}),   // 重放不重复打印用户输出
      new ConsoleStdout(() => {}),
    ];
    const wasi2 = new WASI([cfg.fileName || "program"], [], fds);
    inst = await WebAssembly.instantiate(mod, {
      wasi_snapshot_preview1: wasi2.wasiImport,
      wdb: { probe, pause },
    });
    try { wasi2.start(inst); } catch { /* 到达目标前又 trap / 预算中止：都算未命中 */ }
  } catch { /* 忽略：走简版上报 */ }
  finally {
    replay.active = false;
    inst = prevInst;
    scratchBase = prevScratch;
    pending = prevPending;
  }
  return replay.hit;
}

function reportTrap(e) {
  const msg = String((e && (e.message || e)) || e);
  const frames = captureStack();
  const site = lastSite || null;
  let snap = { memorySegments: null, memorySize: 0 };
  try { snap = snapshotMemory(site || { body: -1 }); } catch {}
  trapped = { reason: msg, site };
  post({
    type: "trap", reason: msg, message: msg, frames,
    site, siteId: site ? site.id : 0,
    memorySegments: snap.memorySegments, memorySize: snap.memorySize,
    // trap 之后栈已展开，locals 不可靠 → 明确给空表，让变量面板显示不可用而不是乱值
    body: site ? site.body : -1, bodyLocals: [], localsBase: 0, globalTypes,
  });
}

const dec = new TextDecoder();
function decode(b) { return dec.decode(b, { stream: true }); }

self.onmessage = (ev) => {
  const m = ev.data || {};
  if (m.type === "init") {
    cfg = m;
    siteById = new Map((m.sites || []).map((s) => [s.id, s]));
    bodyLocals = m.bodyLocals || [];
    globalTypes = m.globalTypes || [];
    ctrl = new Int32Array(m.sab);
    bp = m.breakpointSab ? new Int32Array(m.breakpointSab) : null;
    run();
    return;
  }
  // 注意：暂停期间 worker 阻塞在 Atomics.wait，收不到消息 ——
  // 断点更新/恢复都由宿主直接改 SharedArrayBuffer（见 probe() 与 ctrl 协议）。
  if (m.type === "shutdown") { try { self.close(); } catch {} }
};

self.addEventListener("error", (e) => post({ type: "error", message: "worker error: " + ((e && (e.message || e.error)) || e) }));
self.addEventListener("unhandledrejection", (e) => post({ type: "error", message: "worker rejection: " + ((e && e.reason && (e.reason.stack || e.reason.message)) || e) }));
