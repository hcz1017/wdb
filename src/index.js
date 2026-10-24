// SPDX-License-Identifier: AGPL-3.0-or-later
//
// wdb —— 浏览器里的 WebAssembly 源码级调试器（gdb 的 w 版）。
//
// 这里是唯一的公共出口。核心部分【不依赖任何宿主】（没有 vscode、没有 DOM 假设），
// 宿主只负责三件事：①把 wasm 编出来 ②提供 worker 的 URL ③收发 DAP 消息。
//
// 典型用法（嵌进任何 web IDE）：
//
//   import { instrumentWasm, WasmDebugAdapter, DwarfEngine, SparseMem } from "wdb";
//
//   const engine  = new DwarfEngine(dwarfWorkerUrl, assetsBase, hostGetters);
//   const adapter = new WasmDebugAdapter({ target, getEngine: () => engine, compile, workerUrl, terminal });
//   adapter.onDidSendMessage((msg) => channel.toClient(msg));   // 发给前端
//   channel.onClientMessage((msg) => adapter.handleMessage(msg)); // 收前端的 DAP 请求
//
// 编译期契约（stub ABI v1）：调试产物必须链接 wdb-stub（见 src/stub/），
// 它预置了 import "wdb"."probe" / "wdb"."pause" 两个符号；
// instrumentWasm() 只改写 code 段，不新增 import、不动任何函数索引。

export { instrumentWasm, parseWasm, firstInstrOffset } from "./instrument/wasm-bin.mjs";
export { SparseMem, EMPTY_MEM } from "./runtime/mem-view.mjs";
export { createWorker } from "./runtime/create-worker.js";
export { DwarfEngine } from "./symbols/dwarf.js";
export { WasmDebugAdapter } from "./adapters/dap/adapter.js";
export { DBG_STUB_SOURCE, WDB_ABI_VERSION } from "./stub/wdb-stub.mjs";

/** wdb 的语义版本；DAP 侧可用它做能力协商 */
export const VERSION = "0.1.2";
