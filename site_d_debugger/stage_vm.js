/**
 * stage_vm.js — 用 jsdomFromText 在本地 412 HTML 上执行瑞数 VM, 输出 P-cookie
 *
 * ★ 关键发现 (2026-08-13): /datasearch/ 是两轮 412 挑战 (stage A → stage B → 200)。
 *   每轮: curl_cffi 拿到 412 HTML + O-cookie → 本脚本在本地跑 VM → 输出 P-cookie。
 *   与 jsdomFromUrl 同环境质量 (sdenv 原生 canvas/WebGL + 浏览器补丁),
 *   但 HTML 来自 curl_cffi, 保证 TLS 与最终请求一致。
 *
 * 用法:
 *   node stage_vm.js <412.html路径> <页面URL> [等待秒数=10]
 * stdout: document.cookie 内容 (P-cookie + enable 标志)
 */
const fs = require('fs');
const { jsdomFromText, logger } = require('sdenv');

// 抑制 sdenv 日志
logger.level.level = 50000;

const htmlFile = process.argv[2];
const pageUrl = process.argv[3];
const waitSec = parseInt(process.argv[4] || '10');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

function log(msg) {
  process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

(async function main() {
  const html = fs.readFileSync(htmlFile, 'utf-8');
  log(`html=${html.length}b url=${pageUrl} wait=${waitSec}s`);

  const dom = await jsdomFromText(html, {
    runScripts: 'dangerously',
    resources: 'usable',
    url: pageUrl,
    userAgent: UA,
    beforeParse(window) {
      // try/catch 包裹 timer 回调 — 缺失 API 不中断 VM cookie 生成链
      const st = window.setTimeout;
      const si = window.setInterval;
      window.setTimeout = function (fn, d) {
        return st(function () { try { fn(); } catch (e) {} }, d || 0);
      };
      window.setInterval = function (fn, d) {
        return si(function () { try { fn(); } catch (e) {} }, d || 0);
      };
      // 阻止 redirect — 让 VM 在当前上下文完成 cookie 生成
      window.location.replace = function (newUrl) {
        log(`[BLOCKED] location.replace -> ${newUrl}`);
      };
    },
  });

  const win = dom.window;
  let lastLen = 0;
  let stableCount = 0;
  const t0 = Date.now();
  const finish = () => {
    clearInterval(check);
    clearTimeout(hardStop);
    const ck = win.document.cookie;
    log(`RESULT: ${ck.length} chars @${((Date.now() - t0) / 1000).toFixed(1)}s`);
    for (const p of ck.split(';')) {
      const t = p.trim();
      if (t.includes('=')) {
        const k = t.split('=')[0];
        log(`  cookie: ${k}`);
      }
    }
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
