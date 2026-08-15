/**
 * build_env_browser.js — 方案 B' 手写补环境 (2026-08-15 攻克, 双通过)
 *
 * 架构: JSDOM (sdenv-jsdom fork) + sdenv browser() 补丁函数直调
 *       (脱离 sdenv 的 jsdomFromText 流程, 无 jsdomFromUrl/内部 HTTP 栈)
 *
 * 攻克要点 (三轮探索的最终配方):
 *   1. runScripts 'dangerously' + resources 'usable' — VM 在 parse 阶段执行 (生命周期耦合)
 *   2. browser(w, 'chrome') + getHandle('window')({}) — 补丁层 + 代理 realm
 *   3. ★ VirtualConsole 吞 jsdomError — 泄漏的错误会经 window.onerror 污染 VM 流程,
 *      还会把 [Error] 垃圾写进 cookie jar (此前 400 的直接原因之一)
 *   4. cookieJar + userAgent + pretendToBeVisual — 与 sdenv wrap 同配置
 *   5. 拦截 location.replace/assign — redirect 由调用方 (curl_cffi 链式) 控制
 *
 * 验证 (2026-08-15 实测):
 *   首页 4.8s → 200 (52638b)
 *   /datasearch/ 5.3s → 200 (25152b)
 *   search-result.html 5.7s → 200 (29179b)
 *
 * 用法 (与 sdenv/stage_vm.js 同接口):
 *   node build_env_browser.js <412.html> <页面URL> [等待秒数=10]
 * stdout: document.cookie
 */
const fs = require('fs');
const jsdomPkg = require('sdenv-jsdom');
const VirtualConsole = jsdomPkg.VirtualConsole;
const JSDOM = jsdomPkg.JSDOM;
const CookieJar = jsdomPkg.CookieJar;
const { browser, logger } = require('sdenv');
logger.level.level = 50000;

const htmlFile = process.argv[2];
const pageUrl = process.argv[3];
const waitSec = parseInt(process.argv[4] || '10');
const html = fs.readFileSync(htmlFile, 'utf-8');

function log(m) { process.stderr.write('[' + new Date().toISOString().slice(11, 19) + '] ' + m + '\n'); }

const dom = new JSDOM(html, {
  url: pageUrl,
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  cookieJar: new CookieJar(),
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  virtualConsole: (() => {
    const vc = new VirtualConsole();
    for (const ev of ['log', 'warn', 'error', 'info', 'table', 'jsdomError']) {
      vc.on(ev, () => { });
    }
    return vc;
  })(),
  beforeParse(w) {
    const sdenvInst = browser(w, 'chrome');
    try { sdenvInst.getHandle('window')({}); } catch (e) { log('[WIN-HANDLE] ' + e.message); }
    const nsd = parseInt(html.match(/\$_ts\.nsd\s*=\s*(\d+)/)[1]);
    const cd = html.match(/\$_ts\.cd\s*=\s*"([^"]+)"/)[1];
    w['$_ts'] = { nsd, cd, scj: [], aebi: [] };
    // stage_vm 同款: browser() 之后拦截 redirect (覆盖 sdenv 的 exit 机制)
    w.location.replace = (u) => { log('[BLOCKED] replace'); };
    w.location.assign = () => { };
  },
});

const win = dom.window;
let lastLen = 0, stableCount = 0;
const finish = () => {
  clearInterval(check); clearTimeout(hardStop);
  const ck = win.document.cookie;
  log('RESULT: ' + ck.length + ' chars');
  process.stdout.write(ck);
  try { win.close(); } catch (e) { }
  process.exit(ck ? 0 : 1);
};
const check = setInterval(() => {
  const c = win.document.cookie;
  if (c.length !== lastLen) { lastLen = c.length; stableCount = 0; }
  else if (c.length >= 100) { stableCount++; if (stableCount >= 2) finish(); }
}, 500);
const hardStop = setTimeout(finish, waitSec * 1000);
