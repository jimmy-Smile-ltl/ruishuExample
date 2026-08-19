/**
 * generate_cookie.js — 瑞数6 412 挑战页本地执行, 生成 P-cookie（最简版）
 *
 * 原理: jsdomFromText 在本地用 sdenv-jsdom 环境执行 412 挑战页
 *   （resources:'usable' 自动加载页面外链的 VM 脚本），异步 timer 生成 P-cookie。
 *   唯一注入: timer 回调 try/catch 包裹 + location.replace 阻断（防跳转中断 cookie 链）。
 *
 * 依赖: npm i sdenv（或设环境变量 SDENV_DIR 指向已有 node_modules）
 *
 * 用法:
 *   node generate_cookie.js <412.html> <页面URL> [等待秒数=10]
 * stdout: document.cookie 内容（P-cookie; enable 标志已自动删除）
 */
const fs = require('fs');
const path = require('path');

// sdenv 解析: 本地 node_modules 优先, 否则用 SDENV_DIR 环境变量
let sdenvMod;
try {
  sdenvMod = require('sdenv');
} catch (e) {
  const dir = process.env.SDENV_DIR;
  if (!dir) { console.error('FATAL: 找不到 sdenv — 先 npm install 或设置 SDENV_DIR'); process.exit(2); }
  sdenvMod = require(path.join(dir, 'sdenv'));
}
const { jsdomFromText, logger } = sdenvMod;
logger.level.level = 50000; // 静默 sdenv 日志

const htmlFile = process.argv[2];
const pageUrl = process.argv[3];
const waitSec = parseInt(process.argv[4] || '10');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

function log(msg) { process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`); }

(async function main() {
  const html = fs.readFileSync(htmlFile, 'utf-8');
  log(`html=${html.length}B url=${pageUrl} wait=${waitSec}s`);

  const dom = await jsdomFromText(html, {
    runScripts: 'dangerously',
    resources: 'usable',      // ★ 自动加载 412 页外链的 VM 脚本
    url: pageUrl,
    userAgent: UA,
    beforeParse(window) {
      // timer try/catch — 缺失 API 不中断 cookie 生成链（pro8/pro11 经验）
      const st = window.setTimeout, si = window.setInterval;
      window.setTimeout = function (fn, d) {
        return st(function () { try { fn(); } catch (e) {} }, d || 0);
      };
      window.setInterval = function (fn, d) {
        return si(function () { try { fn(); } catch (e) {} }, d || 0);
      };
      // 阻止 redirect — 让 VM 在当前上下文完成 cookie 生成
      window.location.replace = function (newUrl) {
        log(`[BLOCKED] location.replace -> ${String(newUrl).slice(0, 80)}`);
      };
    },
  });

  const win = dom.window;
  let lastLen = 0, stableCount = 0;
  const t0 = Date.now();
  const finish = () => {
    clearInterval(check);
    clearTimeout(hardStop);
    const ck = win.document.cookie;
    log(`RESULT: ${ck.length} chars @${((Date.now() - t0) / 1000).toFixed(1)}s`);
    process.stdout.write(ck);
    try { win.close(); } catch (e) {}
    process.exit(ck ? 0 : 1);
  };

  // 轮询: cookie 长度 >=100 且连续 2 次稳定 → 提前结束
  const check = setInterval(() => {
    const c = win.document.cookie;
    if (c.length !== lastLen) {
      if (c.length > 0) log(`document.cookie: ${c.length} chars`);
      lastLen = c.length;
      stableCount = 0;
    } else if (c.length >= 100) {
      stableCount++;
      if (stableCount >= 2) finish();
    }
  }, 500);

  const hardStop = setTimeout(finish, waitSec * 1000);
})().catch(err => {
  log('FATAL: ' + err.message);
  process.exit(1);
});
