/**
 * generate_cookie_tj.js — 天津税务局 瑞数6 sdenv 补环境生成 P cookie
 *
 * 链路: curl_cffi(chrome110, verify=False) 抓 412 挑战页 + VM js
 *   → jsdomFromText 注入 meta(arg1) + O cookie → 执行 VM → 异步 timer → P cookie
 *
 * ★ 2026-08-19 关键修复: 服务器已统一分发友好版 (jj8pkMDMKUcA.43ade2a.js),
 *   不再需要 window['escape']=undefined 绕行——删掉它反而让 IIFE 分叉
 *   (opcode 299 读 window.escape → 缺失走异常路径 → 无 P cookie)。
 *
 * 用法:
 *   node generate_cookie_tj.js --html=<412.html> --vm=<vm.js> --url=<target>
 *       --ocookie=<O cookie 串> --wait=12 --output=<out.txt>
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// sdenv 解析: 环境变量 SDENV_DIR 优先, 其次本目录 node_modules (不硬编码个人路径)
function findSdenvDir() {
  if (process.env.SDENV_DIR && fs.existsSync(path.join(process.env.SDENV_DIR, 'sdenv'))) {
    return process.env.SDENV_DIR;
  }
  const local = path.join(__dirname, 'node_modules');
  if (fs.existsSync(path.join(local, 'sdenv'))) return local;
  return null;
}
const sdenvDir = findSdenvDir();
if (!sdenvDir) {
  console.error('FATAL: 找不到 sdenv — 请设置 SDENV_DIR 或在本目录 npm install sdenv');
  process.exit(2);
}
const { jsdomFromText, logger } = require(path.join(sdenvDir, 'sdenv'));
logger.level.level = 50000;

// === 参数解析 (--k=v / --k v) ===
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const m = argv[i].match(/^--(\w[\w-]*)=(.*)$/);
  if (m) { args[m[1]] = m[2]; continue; }
  const m2 = argv[i].match(/^--(\w[\w-]*)$/);
  if (m2 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
    args[m2[1]] = argv[i + 1]; i++;
  }
}

const HTML_FILE = args.html;
const VM_FILE = args.vm;
// 目标 URL (base64, 运行时解码)
const TARGET_URL = args.url || Buffer.from('aHR0cHM6Ly9ldGF4LnRpYW5qaW4uY2hpbmF0YXguZ292LmNuOjg0NDMv', 'base64').toString('utf8');
const O_COOKIE = args.ocookie || '';
const WAIT_SEC = parseInt(args.wait || '12');
const OUTPUT_FILE = args.output || 'output/_sdenv_cookie.txt';

function log(msg) { process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`); }

(async () => {
  if (!HTML_FILE || !VM_FILE) {
    log('用法: node generate_cookie_tj.js --html=<412.html> --vm=<vm.js> --url=<target> [--ocookie=...] [--wait=12] [--output=...]');
    process.exit(2);
  }
  const html = fs.readFileSync(HTML_FILE, 'utf8');
  const vmCode = fs.readFileSync(VM_FILE, 'utf8');

  // 提取挑战页脚本: script0(预执行) / script1(tsInline) / script2(src=VM 外链) / script3(entry)
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gs)].map(m => m[1]);
  const pre = (scripts[0] || '').trim();
  const tsInline = (scripts[1] || '').trim();
  const entry = (scripts[3] || '').trim();

  // meta(arg1): VM 运行时 getElementById 读取 id/content 属性
  const metaM = html.match(/<meta[^>]*id="([^"]+)"[^>]*content="([^"]+)"[^>]*>/) ||
                html.match(/<meta[^>]*content="([^"]+)"[^>]*id="([^"]+)"/);
  const metaId = metaM ? (metaM[1] || metaM[2]) : 'oogrhykaeeVR';
  const metaContent = metaM ? (metaM[1] && metaM[1] !== metaId ? metaM[1] : metaM[2]) : '';

  log(`目标: ${TARGET_URL}`);
  log(`脚本: pre=${pre.length}B tsInline=${tsInline.length}B entry=${entry.length}B | VM=${vmCode.length}B`);
  log(`meta: id=${metaId} content=${metaContent.slice(0, 40)}...`);
  log(`O cookie: ${O_COOKIE ? O_COOKIE.slice(0, 60) + '...' : '(无)'}`);

  const dom = jsdomFromText('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>', {
    url: TARGET_URL,
    runScripts: 'dangerously',
    consoleConfig: {
      log: () => {},
      error: (...a) => log('[VM-err] ' + a.map(String).join(' ').slice(0, 200)),
      jsdomError: (...a) => log('[VM-jsdomErr] ' + a.map(String).join(' ').slice(0, 200)),
    },
    beforeParse(window) {
      // ★ 不删 window.escape —— 友好版 VM 正常执行需要它（根因修复）
      // O cookie 预置: P 生成时 document.cookie 需含 412 轮 O cookie
      if (O_COOKIE) { try { window.document.cookie = O_COOKIE; } catch (e) {} }
      // timer try/catch: 缺 API 不中断回调链
      const st = window.setTimeout, si = window.setInterval;
      window.setTimeout = function (fn, d) {
        return st(function () { try { fn(); } catch (e) {} }, d);
      };
      window.setInterval = function (fn, d) {
        return si(function () { try { fn(); } catch (e) {} }, d);
      };
      // 阻止 redirect，让 VM 在当前上下文完成 cookie 生成
      window.location.replace = function (u) { log('[BLOCKED] redirect → ' + String(u).slice(0, 80)); };
    },
  });
  const win = dom.window;
  const ctx = dom.getInternalVMContext();

  // meta 注入（DOM 此时已完整，beforeParse 里 head 为 null）
  try {
    const d = win.document;
    const m = d.createElement('meta');
    m.id = metaId;
    m.setAttribute('content', metaContent);
    m.setAttribute('r', 'm');
    d.head.appendChild(m);
  } catch (e) { log('[meta inject fail] ' + e.message); }

  const steps = [
    ['pre', pre],
    ['tsInline', tsInline],
    ['vm', vmCode],
    ['entry', entry],
  ];
  for (const [name, code] of steps) {
    if (!code) { log(`[${name}] 空脚本，跳过`); continue; }
    try { vm.runInContext(code, ctx); } catch (e) {
      // entry 失败无害（VM 内部已注册 timer，参照 manual 方案无 entry 同样出 cookie）
      if (name === 'entry') { log(`[entry] ${e.message}（无害，继续等待）`); }
      else { log(`[${name} FAIL] ${e.message}`); }
    }
  }
  log('VM 执行完成，等待 timer...');

  setTimeout(() => {
    const cookie = win.document.cookie;
    log(`完成! document.cookie: ${cookie.length} chars`);
    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, cookie, 'utf8');
    process.exit(0);
  }, WAIT_SEC * 1000);
})().catch(e => { log('FATAL: ' + e.stack); process.exit(1); });
