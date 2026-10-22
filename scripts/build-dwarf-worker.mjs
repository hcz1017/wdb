// 把上游 @vscode/dwarf-debugging 的 worker.js 改造成「经典 Worker 可直接 importScripts」的版本。
//
// 上游 worker.js 是 Node 的 CJS 打包（worker_threads + fs.readFile 读 SymbolsBackend.wasm）。
// 浏览器里没有 require / __filename，但 emscripten 的 Node 分支在浏览器里本来就不会执行
// （ENVIRONMENT_IS_NODE=false），所以只需要在上游代码最前面注入一层极小的 shim：
//   · require("url"/"path"/"worker_threads"/"fs"/"crypto"/"ws")
//   · parentPort → self.postMessage / self.onmessage
//   · fs.promises.readFile("/SymbolsBackend.wasm") → fetch 我们托管的 .wasm.gz
//
// 用法：node scripts/build-dwarf-worker.mjs
// 输入：.dev/dwarf-pkg/package/dist/{worker.js, SymbolsBackend.wasm}
// 输出：assets/dwarf/{worker.js, SymbolsBackend.wasm.gz, LICENSE}
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { gzipSync } from "zlib";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
// 上游包解包位置（不随仓库分发，见 .gitignore）：默认 wdb/.dev-dwarf-pkg/package
// 也兼容 --src=<path> 与老位置 ../extension/.dev/dwarf-pkg/package
const argSrc = (process.argv.find((a) => a.startsWith("--src=")) || "").slice(6);
const SRC = argSrc
  ? path.resolve(argSrc)
  : [
      path.join(ROOT, ".dev-dwarf-pkg/package"),
      path.resolve(ROOT, "..", "extension", ".dev", "dwarf-pkg", "package"),
    ].find((p) => existsSync(p)) || path.join(ROOT, ".dev-dwarf-pkg/package");
const OUT = path.join(ROOT, "assets/dwarf");

// 优先用原始（未 patch）文件：调试时可能会把 patch 结果覆盖到 worker.js
const origPath = path.join(SRC, "dist/worker.orig.js");
const workerPath = existsSync(origPath) ? origPath : path.join(SRC, "dist/worker.js");
const wasmPath = path.join(SRC, "dist/SymbolsBackend.wasm");
for (const p of [workerPath, wasmPath]) {
  if (!existsSync(p)) {
    console.error(`缺少输入文件: ${p}\n  先下载 npm 包: npm pack @vscode/dwarf-debugging@0.0.2 并解包到 wdb/.dev-dwarf-pkg/package`);
    process.exit(1);
  }
}
mkdirSync(OUT, { recursive: true });

let src = readFileSync(workerPath, "utf8");

// ---- 改动 1：import_meta_url 在浏览器里取 worker 自身 URL ----
const origMeta = `var import_url = require("url");\nvar import_meta_url = (0, import_url.pathToFileURL)(__filename);`;
if (!src.includes(origMeta)) throw new Error("未找到 import_meta_url 原始代码（上游版本变了？）");
src = src.replace(
  origMeta,
  `var import_meta_url = (() => {
  // 引擎只在 emscripten 的 locateFile 分支里用它（我们的 wasm 加载走 fetch 覆盖，不依赖这个文件路径），
  // 但那一行会在 addRawModule 时才执行，任何非法值都会让整个引擎初始化失败。
  // 所以这里逐级兜底，并且保证返回值一定是合法 URL。
  // 注意顺序：必须先用 __wdbDwarfBase。Web 扩展宿主会把 Worker 包成 blob: URL，
  // blob: 虽然是合法 URL，但 new URL(relative, blobURL) 会抛 Invalid URL。
  try {
    const base = (typeof self !== "undefined" && self.__wdbDwarfBase) || "";
    if (base) {
      let b = String(base);
      while (b.endsWith("/")) b = b.slice(0, -1);
      return new URL(b + "/dwarf/worker.js");
    }
  } catch (e) { /* 继续兜底 */ }
  try {
    if (typeof self !== "undefined" && self.location && self.location.href) return new URL(self.location.href);
  } catch (e) { /* 继续兜底 */ }
  return new URL("https://oi.invalid/dwarf/worker.js");
})();`,
);

// ---- 改动 1b：emscripten 计算 wasmBinaryFile 那一行加诊断 ----
// 正常情况下我们用 instantiateWasm + fetch 覆盖加载，不会用到这个路径；但它会在模块初始化时
// 无条件执行一次 new URL，任何环境差异都会在这里炸掉（浏览器里曾表现为 "TypeError: Invalid URL"）。
src = src.replace(
  `wasmBinaryFile = new URL("SymbolsBackend.wasm", import_meta_url).toString();`,
  `try {
      wasmBinaryFile = new URL("SymbolsBackend.wasm", import_meta_url).toString();
    } catch (e) {
      console.warn("[wdb] import_meta_url 非法:", typeof import_meta_url, String(import_meta_url),
        "| location:", (typeof self !== "undefined" && self.location) ? self.location.href : "(无 self.location)");
      wasmBinaryFile = "SymbolsBackend.wasm";
    }`,
);

// ---- 改动 2：浏览器环境 shim（在 Node 下整体跳过，因此同一份文件两边都能跑）----
const shim = `"use strict";
/* ===== oi-cpp-wasm: browser shim（Node 下自动跳过）=====
   上游 worker.js 是用 emscripten -sENVIRONMENT=node 编的：它硬性要求
   \`typeof process == "object" && typeof require == "function"\`，否则直接抛
   "not compiled for this environment"。所以这里除了 require/__filename 之外，
   还要伪造一个最小的 process —— 它实际只用到 process.stdin.fd（我们不走的 TTY 分支），
   真正的 wasm 文件加载已经被 ResourceLoader.createSymbolsBackendModulePromise 覆盖成 fetch。 */
if (typeof require === "undefined") {
  var __dirname = "/";
  var __filename = "/worker.js";
  var parentPortShim = {
    postMessage: (m) => self.postMessage(m),
    on: (ev, cb) => { self.onmessage = (e) => cb(e.data); },
  };
  if (typeof process === "undefined") {
    var process = {
      argv: ["node", "worker.js"],
      env: {},
      platform: "linux",
      version: "v20.0.0",
      versions: { node: "20.0.0" },
      pid: 1,
      stdin: { fd: 0 },
      stdout: { write: (s) => console.log(String(s)) },
      stderr: { write: (s) => console.warn(String(s)) },
      cwd: () => "/",
      uptime: () => performance.now() / 1000,
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
      exit: (code) => { throw new Error("oi: engine called process.exit(" + code + ")"); },
      on: () => {},
      nextTick: (fn) => queueMicrotask(fn),
      // emscripten 的 emscripten_get_now 在 node 构建里用 process.hrtime
      hrtime: Object.assign(
        (prev) => {
          const us = Math.round(performance.now() * 1000);
          const s = Math.floor(us / 1e6), ns = (us % 1e6) * 1000;
          return prev ? [s - prev[0], ns - prev[1]] : [s, ns];
        },
        { bigint: () => BigInt(Math.round(performance.now() * 1e6)) },
      ),
    };
  }
  if (typeof Buffer === "undefined") {
    // 上游在 getModuleFileName 里用 Buffer.from(id).toString("base64") 生成伪文件名，
    // 这是 node-only 构建里唯一在浏览器路径上会用到的 Buffer API。
    var Buffer = {
      from(v) {
        if (typeof v !== "string") return new Uint8Array(v);
        const bytes = new TextEncoder().encode(v);
        return {
          length: bytes.length,
          bytes,
          toString(enc) {
            if (enc === "base64") {
              let s = "";
              for (const b of bytes) s += String.fromCharCode(b);
              try { return btoa(s); } catch { return String(v); }
            }
            return String(v);
          },
        };
      },
      alloc(n) { return new Uint8Array(n); },
      isBuffer(v) { return v instanceof Uint8Array; },
    };
  }
  var require = (name) => {
    if (name === "url") return {
      pathToFileURL: (p) => new URL(p, self.location.href),
      fileURLToPath: (u) => decodeURIComponent(String(u).split("file://").join("")),
    };
    if (name === "path") return {
      join: (...a) => a.join("/").replace(/\\/{2,}/g, "/"),
      dirname: (p) => p.replace(/\\/[^/]*$/, "") || "/",
      basename: (p) => p.replace(/^.*\\//, ""),
      normalize: (p) => String(p).replace(/\\/{2,}/g, "/"),
    };
    if (name === "worker_threads") return { parentPort: parentPortShim };
    if (name === "fs") return {
      promises: {
        readFile: async (p) => {
          // 上游只会读 SymbolsBackend.wasm：改成 fetch 我们托管的压缩资产
          const base = String(self.__wdbDwarfBase || "").replace(/\\/+$/, "");
          const r = await fetch(base + "/dwarf/SymbolsBackend.wasm.gz");
          if (!r.ok) throw new Error("SymbolsBackend.wasm.gz: HTTP " + r.status);
          return new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
        },
      },
      readSync() { throw new Error("fs.readSync 在浏览器 worker 里不支持"); },
      readFileSync() { throw new Error("fs.readFileSync 在浏览器 worker 里不支持（wasm 走 fetch 覆盖路径）"); },
      readFile(id, opts, cb) {
        const done = typeof opts === "function" ? opts : cb;
        done(new Error("fs.readFile 在浏览器 worker 里不支持（wasm 走 fetch 覆盖路径）"));
      },
    };
    if (name === "crypto") return {
      randomUUID: () => (self.crypto && self.crypto.randomUUID
        ? self.crypto.randomUUID()
        : String(Math.random()).slice(2) + Date.now().toString(16)),
    };
    if (name === "module") return { builtinModules: [] };
    if (name === "ws") return {};
    throw new Error("browser worker 不支持 require(\\"" + name + "\\")");
  };
}
/* ===== shim 结束 ===== */
`;
src = shim + src;

// ---- 改动 3：RPC 错误带上栈 ----
// 上游只把 `${error}` 发回宿主，浏览器里排查"引擎内部抛错"时看不到调用栈。
// 这个替换只影响错误信息文本，不改变控制流。
src = src.replace(
  "this.channel.postMessage({ requestId, error: `${error}` });",
  "this.channel.postMessage({ requestId, error: String((error && (error.stack || error)) || error) });",
);

// ---- 改动 4：std::vector 之类的容器在变量面板里能展开 ----
// 上游的 formatVector 走的是 libc++ 的 __begin_/__end_，逻辑没问题，
// 但匹配用的是 /^std::vector<.+>$/ —— 我们这套 sysroot 的 ABI 命名空间是 std::__2，
// 真实类型名是 "std::__2::vector<int, std::__2::allocator<int>>"，所以永远匹配不上，
// 变量面板里 vector 就只是个不能展开的类。
const fmtVectorOld = "CustomFormatters.addFormatter({ types: reMatch(/^std::vector<.+>$/), format: formatVector });";
if (!src.includes(fmtVectorOld)) throw new Error("未找到 formatVector 注册代码（上游版本变了？）");
src = src.replace(
  fmtVectorOld,
  `// [oi patch] 兼容 libc++ 的 ABI 命名空间（std::__2::vector / std::__1::vector）
CustomFormatters.addFormatter({ types: reMatch(/^(?:std::)?(?:__\\w+::)?vector<.+>$/), format: formatVector });`,
);

// ---- 改动 5：容器下标表达式 dfn[v] 能用 ----
// 后端的表达式求值器只会对"数组或指针"做下标，std::vector / std::array 都是类类型，
// 于是 watch 里写 dfn[v] 直接抛
//   EvalError: subscripted value is not an array or pointer
// （gdb 能求值是因为它能真的调用 operator[]，纯 DWARF 引擎做不到）。
// 这里在宿主侧兜底：一旦是这种错误，就把 x[i] 依次改写成 x.__begin_[i]（vector）、
// x.__elems_[i]（std::array）再试一次 —— 等价于 gdb 里手写 dfn._M_start[v] 的老办法。
const evalOld = `      const typeInfoResult = manage(moduleInfo.dwarfSymbolsPlugin.EvaluateExpression(apiRawLocation, expression, proxy));
      const error = manage(typeInfoResult.error);
      if (error) {
        if (error.code === moduleInfo.backend.ErrorCode.MODULE_NOT_FOUND_ERROR) {
          return null;
        }
        throw new Error(\`\${moduleInfo.stringifyErrorCode(error.code)}: \${error.message}\`);
      }`;
if (!src.includes(evalOld)) throw new Error("未找到 EvaluateExpression 调用点（上游版本变了？）");
src = src.replace(
  evalOld,
  `      // [oi patch] 容器下标兜底：x[i] → x.__begin_[i] / x.__elems_[i]
      const oiCandidates = (() => {
        const m = /^([\\s\\S]+?)\\[([^\\[\\]]+)\\]\\s*$/.exec(String(expression || "").trim());
        if (!m) return [expression];
        const base = m[1].trim();
        const idx = m[2].trim();
        if (!base || !idx) return [expression];
        return [expression, base + ".__begin_[" + idx + "]", base + ".__elems_[" + idx + "]"];
      })();
      let typeInfoResult = null;
      let error = null;
      for (const oiExpr of oiCandidates) {
        const oiResult = manage(moduleInfo.dwarfSymbolsPlugin.EvaluateExpression(apiRawLocation, oiExpr, proxy));
        const oiError = manage(oiResult.error);
        if (!oiError) { typeInfoResult = oiResult; error = null; break; }
        typeInfoResult = null;
        error = oiError;
        if (oiError.code === moduleInfo.backend.ErrorCode.MODULE_NOT_FOUND_ERROR) {
          return null;
        }
        // 只有"下标不是数组/指针"才值得换写法；语法错、名字不存在等直接报原错
        if (!/subscripted value is not an array or pointer/.test(String(oiError.message))) break;
      }
      if (!typeInfoResult) {
        throw new Error(\`\${moduleInfo.stringifyErrorCode(error.code)}: \${error.message}\`);
      }`,
);

writeFileSync(path.join(OUT, "worker.js"), src);

// ---- 资产：SymbolsBackend.wasm 压缩（56MB → 约十几 MB）----
const wasm = readFileSync(wasmPath);
const gz = gzipSync(wasm, { level: 9 });
writeFileSync(path.join(OUT, "SymbolsBackend.wasm.gz"), gz);
writeFileSync(path.join(OUT, "LICENSE"), readFileSync(path.join(SRC, "LICENSE")));
// .d.ts 文件目录是上游导出类型的相对路径，运行时不依赖（worker.js 已打包全部逻辑）

console.log(`✓ assets/dwarf/worker.js               ${(src.length / 1024).toFixed(0)}KB`);
console.log(`✓ assets/dwarf/SymbolsBackend.wasm.gz  ${(wasm.length / 1048576).toFixed(1)}MB → ${(gz.length / 1048576).toFixed(1)}MB`);
console.log("✓ assets/dwarf/LICENSE                 (MIT, Microsoft / Chrome DevTools)");
