# wdb

**Source-level WebAssembly debugger that runs inside a web page.**
`gdb` 是给进程的，`wdb` 是给模块的。

> ⚠️ **状态**：0.1.0，早期。API 会变，协议带版本号（stub ABI v1）。欢迎用，但别指望它今天就像 lldb 一样稳。

```
你的网页  ──DAP──▶  wdb adapter ──SAB──▶  被冻结的 wasm 线程
                        └─────RPC─────▶  DWARF 符号引擎
```

---

## 它解决什么问题

浏览器里调试 C/C++ 编译出来的 wasm，现有路径基本只有两条，都不好用：

| 现有方案 | 卡在哪 |
|---|---|
| Chrome DevTools + “C/C++ WebAssembly Debugging” 扩展 | 必须用桌面 Chrome、装扩展、开实验开关；且**只能在 DevTools 里** |
| VS Code + `ms-vscode.wasm-dwarf-debugging` | 背后还是连 Chrome 的 CDP，桌面版独占；Web 版 VS Code 根本没法 attach |
| Wasmtime / WAMR + LLDB / gdb | 强，但要装原生工具链，进不了浏览器 |

**在 Web IDE（vscode.dev、自托管 vscode-web）、在线判题、教学平台里，这条路是空的。**
wdb 填的就是这一格：给它一个带 DWARF 的 `.wasm` 和一块编辑器，按 F5 就停在源码行上——不装任何东西。

---

## 长处（现在的确做得不错）

- **纯页面内自足**：不需要 DevTools、不需要浏览器扩展、不需要 CDP、不需要本机后台进程。
  跨源隔离（COOP/COEP）+ SharedArrayBuffer 就够。
- **真源码级**：断点、单步（step in/over/out）、调用栈、变量、watch 表达式，全部映射回 C++ 源码行。
- **零工具链假设**：只要调试产物链接了 `wdb-stub.c`（100 行不到），C / C++ / Rust / Zig 都能调。
  插桩只改 code 段，不新增 import、不动函数索引——所以不会把程序改坏。
- **暂停代价可控**：调试栈可以开到 512MB（深递归不炸），暂停时只拷贝“低区 + 实际用到的栈”，
  不会因为栈大就卡死。
- **单步语义对齐 gdb**：断点永远优先；`next` 不乱飞（同函数体或已返回调用者才停）；
  `stepOut` 以栈深度变浅为准，而不是“换了个函数就停”。
- **容器可展开**：`std::vector` / `std::array` 能手写 `v[i]` 求值，变量面板里也能展开成 `[0] [1] [2] …`
  （libc++ 的 `std::__2` ABI 命名空间已适配）。
- **DAP 原生**：任何 DAP 前端（VS Code、Monaco 系、Theia、Neovim…）接上来只要一个薄适配器。
- **可回归**：全套流程能在 Node 里跑（不需要浏览器），单步语义这类最容易坏的地方有测试兜着。

---

## 暂时不足（诚实清单）

**能力边界**

- **不会执行代码**。`evaluate` 只做符号+内存推导，不会像 gdb 那样真调用函数。
  所以 `v.size()`、`mp.count(x)`、用户自己的函数都求不了值；`v[i]` 是靠内部指针
  （`__begin_` / `__elems_`）兜底出来的，不是真的调 `operator[]`。
- **STL 支持是“够用”而不是“完整”**：vector / array 走得通，`string`（长短串 SSO）、
  `map`/`set`（红黑树遍历）、`deque`、`priority_queue` 还没有专门展开。
- **只支持 DWARF 后端**（当前接的是微软的 `@vscode/dwarf-debugging` wasm 引擎）。
  不认 source map，所以 emscripten 的 `-gsource-map` 路线不在范围内。
- **单线程假定的暂停模型**：暂停靠 `Atomics.wait` 冻结 worker，暂停期间不能再执行 wasm
  （这也是“没法像 gdb 那样调用函数”的根本原因）。

**工程质量**

- **插桩点必须落在操作数栈为空的指令边界**。这是正确性红线，`-O0` 输出没问题，
  但 `-O2` 及以上会大量出现“找不到可用插桩点”，行为是**少断点**而不是错值——这一点必须知道。
- **大容器展开没有分页**：十万个元素的 vector 展开会一次性算完，UI 可能卡。
  （DAP 有 `indexedVariables` 分页机制，我们还没用上。）
- **API 未冻结**：`src/index.js` 的导出、SAB 控制块布局、stub ABI 都可能变，变就升版本号。
- **只在 Chrome / V8 上验证过**。Firefox 的 SAB + 多线程配置不同，未测试。
- **内存快照是"低区 16MB + 栈"**：堆超过 16MB 的部分不在快照里，读那里的变量会显示 0。

---

## 快速上手（嵌进你自己的页面）

```js
import { instrumentWasm, DwarfEngine, WasmDebugAdapter } from "wdb";

const engine = new DwarfEngine(dwarfWorkerUrl, "/assets", hostGetters); // 符号引擎
await engine.start();

const adapter = new WasmDebugAdapter({
  target: { source, fileName: "main.cpp", flags: "" },
  getEngine: () => engine,
  compile: async (args) => myToolchain.compile({ ...args, debugStub: true }), // 必须链 wdb-stub
  workerUrl: debugWorkerUrl,
  terminal: { write: (s) => console.log(s) },
});

adapter.onDidSendMessage((msg) => channel.send(msg));       // → 前端
channel.onMessage((msg) => adapter.handleMessage(msg));     // ← 前端（DAP）
```

编译侧只要做一件事：调试产物链接 `src/stub/wdb-stub.c`：

```sh
clang --target=wasm32-wasip1 -g -O0 -c main.cpp -o main.o
clang --target=wasm32-wasip1 -g -c src/stub/wdb-stub.c -o wdb-stub.o
wasm-ld --export-dynamic -z stack-size=536870912 main.o wdb-stub.o -o a.wasm
```

然后 `instrumentWasm(a.wasm)` 扫出语句站点并改写 code 段。

---

## 协议（三个都要看）

| 协议 | 谁和谁 | 版本 |
|---|---|---|
| **stub ABI**：`wdb.probe(i32)->i32` / `wdb.pause()` | 编译器 ↔ wdb | v1 |
| **SAB 控制块**：`ctrl[0]=状态 ctrl[1]=恢复模式` | 宿主线程 ↔ 冻结的 wasm 线程 | v1 |
| **DAP**（JSON） | wdb ↔ 任意前端 | 上游标准 |

暂停期间 worker 阻塞在 `Atomics.wait`，**收不到任何消息**——断点增删和 continue/step 全部
靠直接改 SharedArrayBuffer，这是设计约束，不是偷懒。

---

## 许可证

- 主体：**AGPL-3.0-or-later**（见 `LICENSE`）
- stub：**AGPL-3.0-or-later WITH WdbStub-exception**（见 `LICENSE.exception`）
  —— 把它链进你的程序，**不会**让你的程序变成 AGPL
- `assets/dwarf/`：微软 MIT，原样保留（见 `NOTICE` 与 `assets/dwarf/LICENSE`）

**你的程序归你**：wdb 对编译/插桩产出的 `.wasm` 不主张任何权利。

---

## 名字

`wdb` = **w**asm **d**e**b**ugger。`gdb` 的 w 版。
