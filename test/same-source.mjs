// 断点来源文件判定（sameSourceFile）单元测试 —— 纯函数，秒级。
//
// 这块踩过两次反向的坑，所以把两种极端都钉成用例：
//   · 只比文件名 → 别的目录的同名文件断点串过来，程序在莫名其妙的地方停；
//   · 只比完整字符串 → 同一文件的不同写法对不上，断点全"未验证"、程序根本不停
//     （真实形态：宿主发 "\ws\sub\a.cpp"（工作区根名 + 反斜杠、无 scheme），
//      而我们手里是 "file:///ws/sub/a.cpp"）。
import { sameSourceFile, sourcePathKey, sourceBaseName } from "../src/adapters/dap/adapter.js";

let pass = true;
const must = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) pass = false; return c; };

// ---------- 同一个文件的各种写法：都必须判为“是” ----------
const TGT = "file:///ws/sub/a.cpp";
must(sameSourceFile(TGT, TGT), "完全相同");
must(sameSourceFile(TGT, "\\ws\\sub\\a.cpp"), "工作区根名 + 反斜杠（宿主真实形态）");
must(sameSourceFile(TGT, "/ws/sub/a.cpp"), "等价的绝对路径");
must(sameSourceFile(TGT, "vscode-file://vscode-app/ws/sub/a.cpp"), "换了 scheme 但路径相同");
must(sameSourceFile(TGT, "a.cpp"), "只剩文件名（信息不足时的兜底）");
must(sameSourceFile(TGT, "sub/a.cpp"), "尾部两级相对路径");
must(sameSourceFile("file:///ws/sub/%E4%B8%AD%E6%96%87.cpp", "中文.cpp"), "percent-encoded vs 原始中文名");
must(sameSourceFile("file:///ws/sub/%E4%B8%AD%E6%96%87.cpp", "sub/中文.cpp"), "percent-encoded 目标 vs 相对路径原始名");
must(sameSourceFile("file:///ws/sub/a%20b.cpp", "sub/a b.cpp"), "空格被编码（%20）");

// ---------- 不是同一个文件：必须判为“否” ----------
must(!sameSourceFile("file:///ws/a.cpp", "\\ws\\b.cpp"), "同目录不同文件");
must(!sameSourceFile("file:///ws/a.cpp", "\\ws\\sub\\other.cpp"), "不同子目录不同文件");
must(!sameSourceFile("file:///ws/sub/a.cpp", "\\ws\\sub\\a2.cpp"), "同目录、名字前缀相同但不是同一文件");
must(!sameSourceFile("file:///ws/x/a.cpp", "/ws/y/a.cpp"), "同名不同目录（两边都带目录 → 必须拒绝）");
must(!sameSourceFile("file:///x/y/a.cpp", "/z/a.cpp"), "尾部两级不同 → 拒绝");
must(!sameSourceFile("file:///ws/a.cpp", ""), "空来源");
must(!sameSourceFile("", ""), "两边都空");

// ---------- 辅助函数 ----------
must(sourcePathKey("file:///a/b.cpp") === "/a/b.cpp", "sourcePathKey 去掉 scheme/authority");
must(sourcePathKey("vscode-test-web://mount/a/b.cpp") === "/a/b.cpp", "sourcePathKey 处理 authority");
must(sourcePathKey("\\a\\b.cpp") === "/a/b.cpp", "sourcePathKey 统一反斜杠");
must(sourceBaseName("file:///ws/%E4%B8%AD.cpp") === "中.cpp", "sourceBaseName 解码中文");

console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
