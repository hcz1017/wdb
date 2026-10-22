// SPDX-License-Identifier: AGPL-3.0-or-later
// wdb 最小自检：资产齐 + 插桩核心可加载（不依赖任何宿主/浏览器）
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
let fail = 0;
const must = (ok, msg) => { if (!ok) fail++; console.log(`${ok ? "✓" : "✗"} ${msg}`); };

const { instrumentWasm, parseWasm, DwarfEngine, SparseMem, DBG_STUB_SOURCE, WDB_ABI_VERSION, VERSION } = await import(
  path.join(ROOT, "src/index.js")
);
must(typeof instrumentWasm === "function", `index.js 导出 instrumentWasm（v${VERSION}）`);
must(typeof parseWasm === "function", "index.js 导出 parseWasm");
must(typeof DwarfEngine === "function", "index.js 导出 DwarfEngine");
must(typeof SparseMem === "function", "index.js 导出 SparseMem");
must(WDB_ABI_VERSION === 1, `stub ABI 版本 = ${WDB_ABI_VERSION}`);
must(DBG_STUB_SOURCE.includes('import_module("wdb")'), 'stub 里是 import_module("wdb")');
must(DBG_STUB_SOURCE.includes('import_name("probe")'), "stub 里有 probe");
must(DBG_STUB_SOURCE.includes('import_name("pause")'), "stub 里有 pause");

for (const f of ["LICENSE", "LICENSE.exception", "NOTICE", "README.md", "src/stub/wdb-stub.c"]) {
  must(existsSync(path.join(ROOT, f)), `存在 ${f}`);
}
for (const f of ["assets/dwarf/worker.js", "assets/dwarf/SymbolsBackend.wasm.gz", "assets/dwarf/LICENSE"]) {
  must(existsSync(path.join(ROOT, f)), `存在 ${f}`);
}
const notice = readFileSync(path.join(ROOT, "NOTICE"), "utf8");
must(/MIT/.test(notice) && /Microsoft/.test(notice), "NOTICE 含微软 MIT 声明（AGPL 分发义务）");
const exc = readFileSync(path.join(ROOT, "LICENSE.exception"), "utf8");
must(/Stub Exception/.test(exc), "LICENSE.exception 是 stub 例外条款");

console.log(fail ? `\n${fail} 项失败` : "\n全部通过");
process.exit(fail ? 1 : 0);
