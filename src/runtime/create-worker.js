// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 宿主无关的 worker 创建（web / 桌面 VS Code / 任意嵌入方都能用）。
//
// ⚠️ 为什么不能无脑 `new Worker(url)`：
//   · 浏览器里从 Marketplace 装的扩展，资源在 CDN 上（**跨源**）→ 跨源 URL 建经典 worker 会被拦；
//   · 桌面 VS Code 的 web 扩展宿主里，扩展资源走 `vscode-file://` 这种自定义 scheme → 同样不能用。
//   两种情况的解法一样：把脚本文本 fetch 下来转成 blob: URL 再建 worker。
//
// 注意 blob worker 内部的相对 URL 以 blob: 为基准，所以给 worker 的一切资源地址都必须是
// **绝对** URL（我们的 worker 本来就用消息传 wasm 字节、或用绝对 base 取资产）。
//
// Node（测试环境）里 workerUrl 可能是普通文件路径，此时直接 new Worker(url) 即可 ——
// 由调用方注入的 Worker shim 处理，不要试图 fetch。

/** 是否是"明确跨源的 http(s)"（这种不要先试，某些浏览器是异步报错，试不出异常） */
function looksCrossOriginHttp(url) {
  if (!/^https?:/i.test(url)) return false;
  try {
    return new URL(url).origin !== self.location.origin;
  } catch {
    return false;
  }
}

/**
 * 创建经典 worker：同源直接建，跨源 / 自定义 scheme 走 fetch + blob。
 * @param {string} url   worker 脚本 URL（或 Node 下的文件路径）
 * @param {{log?: (m:string)=>void}} [opts]
 * @returns {Promise<Worker>}
 */
export async function createWorker(url, opts = {}) {
  const log = opts.log || (() => {});
  const abs = String(url || "");

  if (!looksCrossOriginHttp(abs)) {
    try {
      return new Worker(abs);
    } catch (e) {
      // 自定义 scheme（vscode-file: 等）会在这里抛 → 落到下面的 blob 路径
      log(`worker 直接创建失败，改用 blob：${(e && e.message) || e}`);
    }
  }

  // ⚠️ 加超时：某些宿主（例如桌面版的 Web 扩展宿主）对 vscode-file:// 的 fetch 不返回也不报错，
  //    没有超时就会"卡着不动"，排查时极难定位。
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs || 15000) : null;
  let r;
  try {
    r = await fetch(abs, ctrl ? { signal: ctrl.signal } : undefined);
  } catch (e) {
    throw new Error(`worker 脚本获取失败（${(e && e.message) || e}）：${abs}`);
  } finally { if (timer) clearTimeout(timer); }
  if (!r.ok) throw new Error(`worker 脚本获取失败（HTTP ${r.status}）：${abs}`);
  const code = await r.text();
  const blobUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  log(`worker(blob) ← ${abs}`);
  return new Worker(blobUrl);
}
