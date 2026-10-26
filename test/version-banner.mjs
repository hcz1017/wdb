// wdb 版本号一致性 + 启动横幅内容测试（纯 Node，秒级）。
//
// 为什么要有：调试器启动横幅里会打印 `wdb x.y.z`、许可证和仓库地址，
// 这三样以前是随手写的字符串，很容易和 package.json 漂开。这里钉死。
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WDB_VERSION, WDB_REPO, APP_REPO, WDB_LICENSE } from "../src/version.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = true;
const must = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) pass = false; return c; };

const pkg = JSON.parse(readFileSync(path.join(HERE, "../package.json"), "utf8"));

must(WDB_VERSION === pkg.version, `src/version.js 的版本与 package.json 一致（${WDB_VERSION} vs ${pkg.version}）`);
must(pkg.license === WDB_LICENSE, `许可证一致（${WDB_LICENSE} vs ${pkg.license}）`);
must(pkg.repository && String(pkg.repository.url).includes(WDB_REPO.replace("https://", "")),
  `仓库地址与 package.json 一致（${WDB_REPO}）`);
must(/^https:\/\/github\.com\/[\w-]+\/[\w-]+$/.test(WDB_REPO), `WDB_REPO 是合法 https 仓库地址（${WDB_REPO}）`);
must(/^https:\/\/github\.com\/[\w-]+\/[\w-]+$/.test(APP_REPO), `APP_REPO 是合法 https 仓库地址（${APP_REPO}）`);
must(/^(A|L)?GPL-\d/.test(WDB_LICENSE) || /MIT|Apache/.test(WDB_LICENSE), `许可是 SPDX 标识（${WDB_LICENSE}）`);

// 横幅本身：用假 terminal 真跑一次 _banner()，断言该有的都有
const { WasmDebugAdapter } = await import("../src/adapters/dap/adapter.js");
const written = [];
const fakeTerm = { write: (t) => written.push(String(t)), onInput: () => {}, onEof: () => {}, show: () => {} };
const a = new WasmDebugAdapter({
  target: { source: "int main(){}", fileName: "main.cpp", sourceUri: "file:///w/main.cpp", flags: "" },
  getEngine: async () => null, compile: async () => ({ wasm: new Uint8Array() }),
  workerUrl: "x", log: () => {}, terminal: fakeTerm, version: "9.9.9",
});
a._banner();
const out = written.join("");
must(out.includes(`wdb ${WDB_VERSION}`), `横幅含版本（wdb ${WDB_VERSION}）`);
must(out.includes("WebC++ 9.9.9"), "横幅含宿主扩展版本");
must(out.includes(WDB_LICENSE), `横幅含许可证（${WDB_LICENSE}）`);
must(out.includes(WDB_REPO), `横幅含 wdb 仓库地址`);
must(out.includes(APP_REPO), `横幅含 WebC++ 仓库地址`);
must(/不提供任何担保/.test(out), "横幅含免责声明");
must(/LICENSE\.exception|链接例外/.test(out), "横幅说明桩文件的许可证例外");
must((out.match(/\r\n/g) || []).length >= 5, "多行输出用 CRLF（VS Code 终端要求）");

console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
