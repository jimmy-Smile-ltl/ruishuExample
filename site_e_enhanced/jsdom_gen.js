/**
 * jsdom_gen.js — 站点E 瑞数 Cookie 生成器 (jsdom 环境 + 同步 timer flush)
 *
 * 背景 (jsdom_hybrid.js 决定性实验):
 *   · sdenv/test-local (jsdom + 真实 timer + 等 5s) → 343 chars ✅ 但慢
 *   · rs6_crack.js  手写环境 (同步 flush)          → Invalid array length ❌
 *     站点E VM 检测环境深层结构 (函数 realm/原型链/DOM 集合类型),
 *     手写环境无法对齐 → 检测分叉 → 字符串表解码错位 → 数组膨胀 2^27
 *   · jsdom_hybrid  (jsdom + 同步 flush)          → 421 chars ✅ 秒出
 *     ★ 环境是关键, timer 时序无关 — 同步 flush 不破坏 VM 状态机
 *
 * 本脚本 = 生产版: 参数化输入输出, 供 Python spider.py 调用
 *
 * 用法:
 *   node rs6_node/jsdom_gen.js --html=<412.html> --js=<core.js> \
 *        --ts=<ts_config.json> --cookieo="name=value" --url=<URL>
 *
 * 输出协议 (stdout JSON):
 *   {"ok":true,"prefix":"<随机名>","P":"...","cookie":"name=value; ..."}
 * stderr: 日志
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { jsdomFromText, logger } = require('sdenv');

logger.level.level = 50000; // 抑制 sdenv 日志

// ---------------- CLI 参数 ----------------
function argOf(name, def = null) {
  const a = process.argv.find((x) => x.startsWith(name + '='));
  return a ? a.slice(name.length + 1) : def;
}
const HTML_FILE = argOf('--html');
const JS_FILE = argOf('--js');
const TS_FILE = argOf('--ts');
const COOKIE_O = argOf('--cookieo', '');
const TARGET_URL = argOf('--url',
  Buffer.from('aHR0cHM6Ly93d3cuY2FpY3QuYWMuY24va3h5ai9xd2ZiL2Jwcy8=', 'base64').toString('utf8'));
const MAX_INTERVAL_RUNS = parseInt(argOf('--max-interval-runs', '8'));

for (const f of [HTML_FILE, JS_FILE, TS_FILE]) {
  if (!f || !fs.existsSync(f)) {
    console.error(`[FATAL] 缺少输入文件: ${f}`);
    process.exit(1);
  }
}

const htmlContent = fs.readFileSync(HTML_FILE, 'utf-8');
const vmJsContent = fs.readFileSync(JS_FILE, 'utf-8');
const tsConfig = JSON.parse(fs.readFileSync(TS_FILE, 'utf-8'));

console.error(`jsdom_gen: HTML=${htmlContent.length}B JS=${vmJsContent.length}B nsd=${tsConfig.nsd}`);

// ---------------- 同步 timer 收集器 ----------------
const timeouts = [];
const intervals = [];
let timerId = 0;

function flushTimers(maxRounds = 40, maxIntervalRuns = MAX_INTERVAL_RUNS) {
  for (let round = 0; round < maxRounds; round++) {
    if (timeouts.length === 0 && intervals.every((t) => t.runs >= maxIntervalRuns)) break;
    const pending = timeouts.splice(0, timeouts.length);
    for (const t of pending) {
      try { t.fn(...t.args); } catch (e) { /* 吞掉缺失 API 异常 */ }
    }
    for (const t of intervals) {
      if (t.runs < maxIntervalRuns) {
        t.runs++;
        try { t.fn(...t.args); } catch (e) { /* 吞掉缺失 API 异常 */ }
      }
    }
  }
}

// ---------------- jsdom 环境 ----------------
const minimalHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>`;

const dom = jsdomFromText(minimalHtml, {
  url: TARGET_URL,
  referrer: new URL(TARGET_URL).origin + '/',
  runScripts: 'outside-only',
  resources: 'usable',
  browserType: 'chrome',
  beforeParse(window) {
    // 同步 timer: 收集回调不真等待 (提速核心, jsdom_hybrid 实验验证不破坏 VM 状态机)
    window.setTimeout = function (fn, delay = 0, ...args) {
      const id = ++timerId;
      timeouts.push({ id, fn, args, delay });
      return id;
    };
    window.setInterval = function (fn, delay = 0, ...args) {
      const id = ++timerId;
      intervals.push({ id, fn, args, delay, runs: 0 });
      return id;
    };
    window.clearTimeout = function (id) {
      const i = timeouts.findIndex((t) => t.id === id);
      if (i >= 0) timeouts.splice(i, 1);
    };
    window.clearInterval = function (id) {
      const i = intervals.findIndex((t) => t.id === id);
      if (i >= 0) intervals.splice(i, 1);
    };
  },
});

const win = dom.window;
win.$_ts = { nsd: tsConfig.nsd, cd: tsConfig.cd };
if (win.$_ts.lcd) win.$_ts.lcd();

// ---------------- 执行 VM ----------------
try {
  const script = new vm.Script(vmJsContent);
  const context = vm.createContext(win);
  script.runInContext(context);
  console.error('VM 执行完成');
} catch (e) {
  console.error('VM 错误:', e.message);
  console.error(e.stack.split('\n').slice(0, 8).join('\n'));
}

flushTimers();

// 微任务落地 (XHR/异步回调)
setTimeout(() => {
  flushTimers();
  const docCookie = win.document.cookie;

  // 提取 P-cookie: O cookie 名去掉末尾 O 即前缀
  let prefix = '';
  if (COOKIE_O) prefix = COOKIE_O.split('=')[0].slice(0, -1);
  const pKey = prefix ? prefix + 'P' : '';
  const pVal = pKey ? (docCookie.match(new RegExp(pKey + '=([^;]+)')) || [])[1] : null;

  console.error(`document.cookie: ${docCookie.length} chars, P-cookie: ${pVal ? pVal.length : 0} chars`);

  const out = {
    ok: !!pVal,
    prefix,
    pKey,
    P: pVal || '',
    cookie: docCookie,
  };
  process.stdout.write(JSON.stringify(out));
  win.close();
  process.exit(pVal ? 0 : 1);
}, 200);
