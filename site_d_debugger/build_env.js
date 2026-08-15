/**
 * build_env.js — RS6.js 风格纯 Node.js 补环境 v2
 *
 * 核心改进:
 *   1. 递归 safeMock: 既是函数又是对象，任何操作都不返回 undefined
 *   2. addProxyLog(): RS6.js 风格的 Proxy 日志，追踪 VM 访问了哪些 API
 *   3. 先跑日志模式发现 API → 再定向补充 mock
 *
 * 用法:
 *   node build_env.js              # 正常模式
 *   node build_env.js --debug      # 日志模式 (追踪 API 访问)
 *   node build_env.js --test       # 生成 cookie 后 curl_cffi 测试
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SCRIPT_DIR = __dirname;
// 示例文件夹版: shared/ 就在本目录 (爬虫写入路径一致)
const SHARED_DIR = path.join(SCRIPT_DIR, 'shared');
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output');
const TARGET_URL = Buffer.from('aHR0cHM6Ly93d3cubm1wYS5nb3YuY24v', 'base64').toString('utf8');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const DEBUG = process.argv.includes('--debug');
const DO_TEST = process.argv.includes('--test');
const WAIT_SEC = 12;

function log(msg) { process.stderr.write(`[${new Date().toISOString().slice(11,19)}] ${msg}\n`); }

// ================================================================
// ★ 递归 safeMock: 既是函数又是对象，永不返回 undefined
// ================================================================
function createRecursiveMock(name = '') {
  const handler = {
    get(target, prop) {
      if (prop === Symbol.toPrimitive) return () => name || '';
      if (prop === 'toString') return () => `[mock ${name}]`;
      if (prop === 'valueOf') return () => 0;
      if (prop === Symbol.iterator) return function* () { };
      if (typeof prop === 'symbol') return undefined;
      // 记录 API 访问
      if (DEBUG && typeof prop === 'string' && !prop.startsWith('_')) {
        const key = `${name}.${prop}`;
        if (!handler._seen.has(key)) {
          handler._seen.add(key);
          process.stderr.write(`  [API] ${key}\n`);
        }
      }
      // 递归返回新的 mock
      return createRecursiveMock(name ? `${name}.${String(prop)}` : String(prop));
    },
    apply(target, thisArg, args) {
      if (DEBUG && name) {
        process.stderr.write(`  [CALL] ${name}(${(args||[]).length} args)\n`);
      }
      return createRecursiveMock(name);
    },
    set(target, prop, value) {
      target[prop] = value;
      if (DEBUG) process.stderr.write(`  [SET] ${name}.${String(prop)} = ${String(value).substring(0,40)}\n`);
      return true;
    },
    _seen: new Set(),
  };

  const fn = function () { return createRecursiveMock(name); };
  return new Proxy(fn, handler);
}

// ================================================================
// 步骤 1: 加载 412 配置
// ================================================================
const html = fs.readFileSync(path.join(SHARED_DIR, '412.html'), 'utf-8');
const nsd = parseInt(html.match(/\$_ts\.nsd\s*=\s*(\d+)/)[1]);
const cd = html.match(/\$_ts\.cd\s*=\s*"([^"]+)"/)[1];
const metaM = html.match(/<meta[^>]+content="([^"]+)"[^>]*r=['"]m['"]/);
const metaContent = metaM ? metaM[1] : '';
const scriptSrcM = html.match(/<script[^>]+src="([^"]+\.js)"[^>]*r=['"]m['"]/);
const scriptSrc = scriptSrcM ? scriptSrcM[1] : '';
// 找触发函数 — 在所有 <script r='m'> 标签中
const allTriggers = [];
const triggerRe = /<script[^>]*r=['"]m['"][^>]*>\s*([A-Za-z_$][\w$]*)\(\)/gi;
let tm;
while ((tm = triggerRe.exec(html)) !== null) {
  allTriggers.push(tm[1]);
}
const triggerFn = allTriggers[allTriggers.length - 1] || null;
log(`nsd=${nsd} cd=${cd.length} meta=${metaContent.length} trigger=${triggerFn||'none'} all=[${allTriggers.join(',')}]`);
if (DEBUG) log('DEBUG mode: logging all API access');

// ================================================================
// 步骤 2: 构建浏览器环境
// ================================================================
const win = globalThis;
win.window = win; win.self = win; win.top = win; win.parent = win; win.frames = win;

// Navigator
win.navigator = {
  userAgent: UA, appVersion: '5.0', platform: 'Win32',
  language: 'zh-CN', languages: ['zh-CN', 'zh', 'en'],
  cookieEnabled: true, webdriver: false,
  hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0,
  vendor: 'Google Inc.', vendorSub: '', productSub: '20030107',
  appCodeName: 'Mozilla', appName: 'Netscape', onLine: true,
  plugins: { length: 5, 0: { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' }, 1: { name: 'Chrome PDF Viewer' }, 2: { name: 'Native Client' }, item() { return this[arguments[0]]; }, namedItem() { return null; }, refresh() { } },
  mimeTypes: { length: 4, 0: { type: 'application/pdf', suffixes: 'pdf' }, 1: { type: 'text/pdf' }, item() { return this[arguments[0]]; }, namedItem() { return null; } },
};

// Screen — 对齐 sdenv/jsdom 实测值 (0x0! 站点当前接受该环境)
win.screen = { width: 0, height: 0, availWidth: 0, availHeight: 0, availLeft: undefined, availTop: undefined, colorDepth: 24, pixelDepth: 24, orientation: { type: 'landscape-primary', angle: 0 } };

// Location (★ 拦截 redirect)
win.location = {
  href: TARGET_URL, protocol: new URL(TARGET_URL).protocol, host: new URL(TARGET_URL).host, hostname: new URL(TARGET_URL).hostname,
  port: '', pathname: new URL(TARGET_URL).pathname, search: '', hash: '', origin: new URL(TARGET_URL).origin,
  ancestorOrigins: {},
  replace(url) { log('[BLOCKED] location.replace → ' + url); },
  assign() { }, reload() { }, toString() { return TARGET_URL; },
};
win.history = { length: 3, state: null, pushState() { }, replaceState() { }, back() { }, forward() { }, go() { } };

// ================================================================
// Document + Cookie 拦截 ★
// ================================================================
const _cookieStore = {};
let _docCookie = '';

const metaEl = {
  nodeType: 1, nodeName: 'META', tagName: 'META',
  getAttribute(name) {
    if (name === 'r') return 'm';
    if (name === 'content') return metaContent;
    if (name === 'id') return '13JnD7t9MzWf';
    if (name === 'http-equiv') return 'Content-Type';
    return null;
  },
  hasAttribute(name) { return name === 'r' || name === 'content' || name === 'id' || name === 'http-equiv'; },
  attributes: { r: { value: 'm' }, content: { value: metaContent }, id: { value: '13JnD7t9MzWf' }, 'http-equiv': { value: 'Content-Type' } },
  getElementsByTagName() { return []; },
  childNodes: [], children: [],
  parentNode: null, parentElement: null,
  removeChild(c) { return c; },
  insertBefore() { }, replaceChild() { },
};

const scriptEl = {
  nodeType: 1, nodeName: 'SCRIPT', tagName: 'SCRIPT', type: 'text/javascript',
  getAttribute(name) {
    if (name === 'r') return 'm';
    if (name === 'src') return scriptSrc || '';
    if (name === 'type') return 'text/javascript';
    return null;
  },
  hasAttribute(name) { return name === 'r' || name === 'src' || name === 'type'; },
  setAttribute() { }, removeAttribute() { }, attributes: {},
  parentElement: null, parentNode: null,
  childNodes: [], children: [],
  removeChild(c) { return c; },
};

const _head = {
  nodeName: 'HEAD', tagName: 'HEAD', nodeType: 1,
  getAttribute() { return null; }, hasAttribute() { return false; },
  setAttribute() { }, removeAttribute() { }, attributes: {},
  children: [metaEl, scriptEl], childNodes: [metaEl, scriptEl],
  appendChild(c) { if(c){c.parentNode=_head;c.parentElement=_head;} this.children.push(c); this.childNodes.push(c); return c; },
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); this.childNodes.splice(i, 1); } if(c){c.parentNode=null;c.parentElement=null;} return c; },
  getElementsByTagName(tag) {
    if (tag === 'meta') return [metaEl];
    if (tag === 'script') return [scriptEl];
    return [];
  },
  querySelectorAll() { return []; },
  parentNode: null, parentElement: null,
};
// After _head is defined, set parent links
metaEl.parentNode = _head; metaEl.parentElement = _head;
scriptEl.parentNode = _head; scriptEl.parentElement = _head;

const _body = {
  nodeName: 'BODY', tagName: 'BODY', nodeType: 1,
  getAttribute() { return null; }, hasAttribute() { return false; },
  setAttribute() { }, removeAttribute() { }, attributes: {},
  children: [], childNodes: [], innerHTML: '', innerText: '', textContent: '',
  appendChild(c) { if(c){c.parentNode=_body;c.parentElement=_body;} this.children.push(c); this.childNodes.push(c); return c; },
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); this.childNodes.splice(i, 1); } if(c){c.parentNode=null;c.parentElement=null;} return c; },
  getElementsByTagName() { return []; }, querySelectorAll() { return []; },
  style: {}, parentNode: null, parentElement: null,
};

win.document = {
  nodeType: 9, nodeName: '#document',
  head: _head, body: _body,
  documentElement: { nodeName: 'HTML', tagName: 'HTML', nodeType: 1, getAttribute() { return null; }, hasAttribute() { return false; }, setAttribute() { }, removeAttribute() { }, attributes: {}, outerHTML: html, children: [_head, _body], childNodes: [_head, _body], parentNode: null, parentElement: null },

  // ★ Cookie 拦截
  get cookie() { return _docCookie; },
  set cookie(value) {
    const parts = value.split(';');
    const main = parts[0].trim();
    const eq = main.indexOf('=');
    if (eq > 0) {
      const key = main.substring(0, eq).trim();
      const val = main.substring(eq + 1).trim();
      _cookieStore[key] = val;
      _docCookie = Object.entries(_cookieStore).map(([k, v]) => k + '=' + v).join('; ');
      log(`[COOKIE] ${key}=${val.substring(0, 40)}... (${_docCookie.length} chars)`);
    }
  },

  // DOM 查询
  getElementsByTagName(tag) {
    const t = (tag || '').toLowerCase();
    if (t === 'meta') return [metaEl];
    if (t === 'script') return [scriptEl];
    if (t === 'head') return [_head];
    if (t === 'body') return [_body];
    if (t === 'html') return [win.document.documentElement];
    return [];
  },
  getElementById(id) { return id === '13JnD7t9MzWf' ? metaEl : null; },
  querySelectorAll(sel) { return sel && sel.includes('meta') ? [metaEl] : []; },
  querySelector(sel) { return (sel && sel.includes('meta')) ? metaEl : null; },

  // createElement — 返回合理模拟元素，支持 parentNode 链接
  createElement(tag) {
    const t = (tag || '').toLowerCase();
    const el = {
      nodeName: t.toUpperCase(), tagName: t.toUpperCase(), nodeType: 1,
      children: [], childNodes: [], innerHTML: '', innerText: '', style: {},
      getAttribute() { return null; }, setAttribute() { }, hasAttribute() { return false; },
      appendChild(c) { if(c){c.parentNode=el;c.parentElement=el;} this.children.push(c); this.childNodes.push(c); return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); this.childNodes.splice(i, 1); } if(c){c.parentNode=null;c.parentElement=null;} return c; },
      insertBefore(c, ref) { if(c){c.parentNode=el;c.parentElement=el;} this.children.push(c); this.childNodes.push(c); return c; },
      replaceChild(c, old) { this.removeChild(old); this.appendChild(c); return old; },
      getElementsByTagName() { return []; }, querySelectorAll() { return []; },
      addEventListener() { }, removeEventListener() { }, dispatchEvent() { return true; },
      parentNode: null, parentElement: null,
      getBoundingClientRect() { return { left: 0, top: 0, right: 300, bottom: 150, width: 300, height: 150, x: 0, y: 0 }; },
      ownerDocument: win.document,
    };
    // Canvas 特殊处理
    if (t === 'canvas') {
      const ctx2d = {
        fillStyle: '#000', strokeStyle: '#000', font: '10px sans-serif', lineWidth: 1, globalAlpha: 1,
        fillRect() { log('[CANVAS2D] fillRect'); }, strokeRect() { log('[CANVAS2D] strokeRect'); },
        clearRect() { }, fillText() { log('[CANVAS2D] fillText'); }, strokeText() { },
        measureText(t) { log(`[CANVAS2D] measureText('${String(t).substring(0, 30)}')`); return { width: (t || '').length * 6, actualBoundingBoxAscent: 10 }; },
        beginPath() { }, closePath() { }, moveTo() { }, lineTo() { }, arc() { }, arcTo() { },
        bezierCurveTo() { }, quadraticCurveTo() { }, rect() { }, fill() { }, stroke() { }, clip() { },
        save() { }, restore() { }, scale() { }, rotate() { }, translate() { }, transform() { }, setTransform() { },
        drawImage() { },
        createLinearGradient() { return { addColorStop() { } }; },
        createRadialGradient() { return { addColorStop() { } }; },
        createPattern() { return null; },
        createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
        getImageData(x, y, w, h) {
          const d = new Uint8ClampedArray(w * h * 4);
          for (let i = 0; i < d.length; i++) d[i] = 255;
          return { width: w, height: h, data: d };
        },
        putImageData() { }, getLineDash() { return []; }, setLineDash() { },
      };
      const gl = {
        drawingBufferWidth: 300, drawingBufferHeight: 150,
        getExtension(n) { return n === 'WEBGL_debug_renderer_info' ? { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 } : {}; },
        getSupportedExtensions() { return ['EXT_texture_filter_anisotropic', 'WEBGL_debug_renderer_info', 'OES_texture_float']; },
        getParameter(p) {
          const m = { 3415: 8, 3414: 8, 35661: 24, 3413: 8, 7937: 'ANGLE (NVIDIA GeForce RTX 4060)', 7938: 'WebKit', 7939: 'WebGL 2.0' };
          return m[p] !== undefined ? m[p] : null;
        },
        getShaderPrecisionFormat() { return { rangeMin: 127, rangeMax: 127, precision: 23 }; },
        getContextAttributes() { return { alpha: true, antialias: true, depth: true, stencil: false }; },
        createShader() { return {}; }, createProgram() { return {}; }, createBuffer() { return {}; },
        bindBuffer() { }, bufferData() { }, shaderSource() { }, compileShader() { },
        attachShader() { }, linkProgram() { }, useProgram() { },
        getAttribLocation() { return 0; }, enableVertexAttribArray() { }, vertexAttribPointer() { },
        drawArrays() { }, clear() { }, clearColor() { }, viewport() { },
      };
      el.getContext = function (type) { return type === '2d' ? ctx2d : gl; };
      el.toDataURL = function () { return 'data:image/png;base64,iVBORw0KGgo='; };
      el.width = 300; el.height = 150;
    }
    return el;
  },

  // 事件
  addEventListener() { }, removeEventListener() { }, dispatchEvent() { return true; },
  createEvent() { return { initEvent() { } }; }, createDocumentFragment() { return { appendChild(c) { return c; } }; },
  createTextNode() { return { nodeType: 3, textContent: '' }; },
  createComment() { return {}; },

  // 属性
  charset: 'utf-8', characterSet: 'UTF-8', readyState: 'complete',
  visibilityState: 'visible', hidden: false, hasFocus() { return true; },
  title: '', domain: new URL(TARGET_URL).hostname, URL: TARGET_URL, documentURI: TARGET_URL, referrer: '',
  all: undefined,   // sdenv/jsdom 实测 document.all === undefined

  // 其他
  getElementsByClassName() { return []; }, getElementsByName() { return []; },
  execCommand() { return false; }, hasChildNodes() { return true; },
  createTreeWalker() { return {}; }, createNodeIterator() { return {}; },
  importNode() { return {}; }, adoptNode() { return {}; },
};

// ================================================================
// Storage
// ================================================================
const _ls = {}, _ss = {};
win.localStorage = {
  getItem(k) { return _ls.hasOwnProperty(k) ? _ls[k] : null; },
  setItem(k, v) { _ls[k] = String(v); }, removeItem(k) { delete _ls[k]; },
  clear() { for (const k in _ls) delete _ls[k]; },
  key(i) { return Object.keys(_ls)[i] || null; },
  get length() { return Object.keys(_ls).length; },
};
win.sessionStorage = {
  getItem(k) { return _ss.hasOwnProperty(k) ? _ss[k] : null; },
  setItem(k, v) { _ss[k] = String(v); }, removeItem(k) { delete _ss[k]; },
  clear() { for (const k in _ss) delete _ss[k]; },
  key(i) { return Object.keys(_ss)[i] || null; },
  get length() { return Object.keys(_ss).length; },
};

// ================================================================
// Network
// ================================================================
win.XMLHttpRequest = function () {
  this.readyState = 0; this.status = 0; this.statusText = ''; this.responseText = ''; this.response = '';
  this.responseType = ''; this.timeout = 0; this.withCredentials = false;
  this.onreadystatechange = null; this.onload = null; this.onerror = null; this.onprogress = null;
};
win.XMLHttpRequest.prototype = {
  open() { }, send() { }, setRequestHeader() { }, getResponseHeader() { return null; },
  getAllResponseHeaders() { return ''; }, abort() { }, addEventListener() { },
  overrideMimeType() { },
  get UNSENT() { return 0; }, get OPENED() { return 1; },
  get HEADERS_RECEIVED() { return 2; }, get LOADING() { return 3; }, get DONE() { return 4; },
};
win.XMLHttpRequest.UNSENT = 0;
win.XMLHttpRequest.OPENED = 1;
win.XMLHttpRequest.HEADERS_RECEIVED = 2;
win.XMLHttpRequest.LOADING = 3;
win.XMLHttpRequest.DONE = 4;
win.fetch = undefined;

// ================================================================
// Timers ★ RS6.js 风格: 真 timer + try/catch
// ================================================================
const _st = setTimeout, _si = setInterval, _ct = clearTimeout, _ci = clearInterval;
win.setTimeout = function (fn, d) { return typeof fn === 'function' ? _st(() => { try { fn(); } catch (e) { log('[TIMER-ERR] ' + e.message + (e.stack ? ' | ' + e.stack.split('\n')[1] : '')); } }, d || 0) : 0; };
win.setInterval = function (fn, d) { return typeof fn === 'function' ? _si(() => { try { fn(); } catch (e) { log('[TIMER-ERR] ' + e.message + (e.stack ? ' | ' + e.stack.split('\n')[1] : '')); } }, d || 0) : 0; };
win.clearTimeout = _ct; win.clearInterval = _ci;

// ================================================================
// 其他 API
// ================================================================
win.performance = {
  now() { return Date.now() - 1000000; },
  timing: { navigationStart: Date.now() - 2000, loadEventEnd: Date.now() - 1000, domComplete: Date.now() - 500, domainLookupEnd: Date.now() - 1500, connectEnd: Date.now() - 1200, responseEnd: Date.now() - 800 },
  navigation: { type: 0, redirectCount: 0 },
  getEntries() { return []; }, getEntriesByType() { return []; }, getEntriesByName() { return []; },
  mark() { }, measure() { }, clearMarks() { }, clearMeasures() { },
  memory: { jsHeapSizeLimit: 4294967296, totalJSHeapSize: 10000000, usedJSHeapSize: 8000000 },
};

win.crypto = globalThis.crypto || {
  getRandomValues(arr) { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; },
  subtle: undefined,
  randomUUID() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); }); },
};

win.MutationObserver = function (cb) { this._cb = cb; };
win.MutationObserver.prototype = { observe() { }, disconnect() { }, takeRecords() { return []; } };

win.DOMParser = function () { };
win.DOMParser.prototype = { parseFromString(str, type) { return { documentElement: win.document.documentElement, querySelector() { return null; }, getElementsByTagName() { return []; } }; } };

win.Image = function () { return { src: '', width: 0, height: 0, naturalWidth: 0, naturalHeight: 0, complete: false, onload: null, onerror: null, style: {} }; };
win.HTMLImageElement = function () { };

win.Event = function (type, opts) { this.type = type; this.bubbles = false; this.cancelable = false; if (opts) Object.assign(this, opts); };
win.CustomEvent = function (type, opts) { win.Event.call(this, type); if (opts) this.detail = opts.detail; };
win.MouseEvent = function () { };
win.KeyboardEvent = function () { };
win.UIEvent = function () { };
win.FocusEvent = function () { };
win.InputEvent = function () { };
win.TouchEvent = function () { };
win.WheelEvent = function () { };
win.PointerEvent = function () { };
win.ErrorEvent = function () { };
win.MessageEvent = function () { };
win.PopStateEvent = function () { };
win.HashChangeEvent = function () { };
win.ProgressEvent = function () { };

win.Blob = globalThis.Blob || function (parts, opts) { this.size = 0; this.type = (opts && opts.type) || ''; };
win.File = globalThis.File || function () { };
win.FileReader = globalThis.FileReader || function () { };
win.FileList = function () { };
win.FormData = globalThis.FormData || function () { this.append = function () { }; };
win.URL = globalThis.URL || { createObjectURL() { return 'blob:mock'; }, revokeObjectURL() { } };
win.Blob.prototype = { slice() { return new win.Blob(); }, get size() { return 0; }, get type() { return ''; } };

win.atob = (s) => Buffer.from(s, 'base64').toString('binary');
win.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
win.eval = eval;

win.matchMedia = function (q) { return { matches: false, media: q, onchange: null, addListener() { }, removeListener() { }, addEventListener() { }, removeEventListener() { }, dispatchEvent() { return true; } }; };
win.getComputedStyle = function () { return { getPropertyValue() { return ''; }, getPropertyPriority() { return ''; }, length: 0, item() { return ''; } }; };
win.requestAnimationFrame = function (cb) { return _st(cb, 16); };
win.cancelAnimationFrame = function (id) { _ct(id); };

win.open = function () { return null; };
win.close = function () { };
win.alert = function () { };
win.confirm = function () { return true; };
win.prompt = function () { return null; };
win.print = function () { };
win.postMessage = function () { };
win.scrollTo = function () { }; win.scrollBy = function () { };
win.addEventListener = function () { }; win.removeEventListener = function () { };
win.dispatchEvent = function () { return true; };
win.attachEvent = function () { return true; }; win.detachEvent = function () { };

win.innerWidth = 1024; win.innerHeight = 768;   // sdenv/jsdom 实测
win.outerWidth = 1024; win.outerHeight = 768;
win.screenX = 0; win.screenY = 0; win.screenLeft = 0; win.screenTop = 0;
win.devicePixelRatio = 1;
win.scrollX = 0; win.scrollY = 0; win.pageXOffset = 0; win.pageYOffset = 0;
win.frameElement = null;

win.name = '';
win.chrome = { loadTimes() { return {}; }, csi() { return {}; }, app: { isInstalled: false, InstallState: { DISABLED: 'disabled' }, RunningState: { CANNOT_RUN: 'cannot_run' } }, runtime: { onConnect: { addListener() { } }, onMessage: { addListener() { } } } };
win.external = {};
win.Intl = globalThis.Intl || { DateTimeFormat() { return { format() { return new Date().toLocaleString(); }, resolvedOptions() { return { timeZone: 'Asia/Shanghai', locale: 'zh-CN' }; } }; } };

win.indexedDB = undefined;
win.webkitIndexedDB = undefined;
win.AudioContext = undefined;
win.webkitAudioContext = undefined;
win.OfflineAudioContext = undefined;
win.RTCPeerConnection = undefined;
win.webkitRTCPeerConnection = undefined;
win.Worker = undefined;
win.SharedWorker = undefined;
win.ServiceWorker = undefined;
win.BroadcastChannel = undefined;
win.Notification = undefined;
win.Permissions = undefined;
win.Geolocation = undefined;
win.WebSocket = undefined;
win.SharedWorker = undefined;
win.EventSource = undefined;

// ================================================================
// 步骤 3: 设置 $_ts (★ 瑞数入口)
// ================================================================
// 注意: VM 的 opcode 10 会把 $_ts 重置为 {}，所以先用临时对象
const _tsInit = {
  nsd: nsd,
  cd: cd,
  scj: [], aebi: [],
};
// 普通数据对象 (与 jsdom 中内联脚本设置的 $_ts 同形态)
win['$_ts'] = _tsInit;

// ================================================================
// 混合实验: 用真实 jsdom DOM 替换手写 document (其余 mock 不变)
// ================================================================
if (process.argv.includes('--jsdom-doc')) {
  try {
    const { JSDOM } = require('../sdenv/node_modules/sdenv-jsdom');
    const jd = new JSDOM(html, { url: TARGET_URL, runScripts: 'outside-only' });
    win.document = jd.window.document;
    win.location = jd.window.location;
    log('[EXP] 已替换为真实 jsdom document/location');
  } catch (e) {
    log('[EXP] jsdom 替换失败: ' + e.message);
  }
}

// ================================================================
// 实验: contextify globalThis (新 realm) — 隔离 node realm 内建对象
// ================================================================
if (process.argv.includes('--realm')) {
  try {
    require('vm').createContext(win);
    log('[EXP] 已 contextify globalThis (新 realm)');
  } catch (e) {
    log('[EXP] contextify 失败: ' + e.message);
  }
}

// ================================================================
// 步骤 4: eval 执行 VM 代码
// ================================================================
// v3: 原生伪装层 (setFuncNative + Window 原型链伪造) — native_patch.js
try {
  const { installNativePatches } = require('./native_patch.js');
  installNativePatches(win, log);
} catch (e) {
  log('[NATIVE] patch fail: ' + e.message);
}

// v3: eval 期间隐藏 node 全局 (jsdom 沙箱没有 process/global)
win.eval = (function () {
  const _inner = win.eval;   // native 伪装后的 eval
  const _w = function (code) {
    const _p = process, _g = global;
    try {
      process = undefined; global = undefined;
      return _inner.call(win, code);
    } finally {
      process = _p; global = _g;
    }
  };
  _w.toString = _inner.toString;   // 保持 native 伪装
  return _w;
})();

log('Loading VM...');
const vmCode = fs.readFileSync(path.join(SHARED_DIR, 'vm.js'), 'utf-8');
log(`VM: ${vmCode.length} bytes`);

try {
  eval(vmCode);
  log('VM loaded OK');

  // 列出全局 _$ 函数
  const funcs = Object.getOwnPropertyNames(win).filter(k => k.startsWith('_$') && typeof win[k] === 'function');
  log(`Global _$ functions (${funcs.length}): ${funcs.slice(0, 20).join(', ')}`);

} catch (e) {
  log('VM error: ' + e.message);
  log(e.stack.split('\n').slice(0, 3).join('\n'));
}

// ================================================================
// 步骤 5: 通过 _$cG 创建 $_ts.lcd 解码器
// ================================================================
if (typeof win._$cG === 'function') {
  log('_$cG found, creating $_ts.lcd wrapper...');
  // $_ts.lcd 由 VM 通过 opcode 9 设置。但 VM 可能还没运行。
  // 如果 VM 设置了 lcd，保留它；否则手动创建
  const origLcd = _tsInit.lcd;
  if (typeof origLcd === 'function') {
    log('$_ts.lcd already set by VM');
  } else {
    // VM 没设置 — 手动调用 _$cG(36) 来触发解码
    log('Calling _$cG(36) directly...');
    try {
      const r = win._$cG(36);
      log('_$cG(36) returned: ' + (r !== undefined ? typeof r : 'undefined'));
    } catch (e) {
      log('_$cG(36) error: ' + e.message.substring(0, 100));
    }
  }
}

// ================================================================
// 步骤 6: 调用触发函数
// ================================================================
let triggerCalled = false;
if (triggerFn && typeof win[triggerFn] === 'function') {
  log(`Calling trigger: ${triggerFn}()`);
  try { win[triggerFn](); triggerCalled = true; } catch (e) { log(`trigger ${triggerFn} error: ${e.message}`); if (e.stack) log(e.stack.split('\n').slice(0, 8).join('\n')); }
}
if (!triggerCalled) {
  for (const name of allTriggers) {
    if (typeof win[name] === 'function') {
      log(`Calling trigger: ${name}()`);
      try { win[name](); triggerCalled = true; } catch (e) { log(`trigger ${name} error: ${e.message}`); }
      if (triggerCalled) break;
    }
  }
}
if (!triggerCalled) {
  for (const name of ['_$mW', '_$cd', '_$_8', '_$cK', '_$b2', '_$nV', '_$cn', '_$nB', '_$eH', '_$$k', '_$_s']) {
    if (typeof win[name] === 'function') {
      log(`Calling trigger: ${name}()`);
      try { win[name](); triggerCalled = true; } catch (e) { log(`trigger ${name} error: ${e.message}`); }
      if (triggerCalled) break;
    }
  }
}
if (!triggerCalled) {
  log('No trigger function found');
}

// ================================================================
// 步骤 7: 等待 Cookie 生成
// ================================================================
log(`Waiting ${WAIT_SEC}s for cookie...`);
let elapsed = 0;
let lastCookieLen = 0;
const outFile = path.join(OUTPUT_DIR, '_cookie.txt');

const check = setInterval(() => {
  elapsed++;
  const ck = win.document.cookie;

  if (ck.length !== lastCookieLen) {
    lastCookieLen = ck.length;
    if (ck.length > 0) {
      log(`Cookie @${elapsed}s: ${ck.length} chars`);
    }
  }

  if (elapsed >= WAIT_SEC) {
    clearInterval(check);

    log('');
    log('='.repeat(60));
    log(`RESULT: document.cookie = ${ck.length} chars`);
    if (ck) {
      for (const p of ck.split(';')) {
        const t = p.trim();
        if (t.includes('=')) {
          const [k, ...v] = t.split('=');
          const val = v.join('=');
          log(`  ${k}=${val.substring(0, 60)}${val.length > 60 ? '...' : ''}`);
        }
      }
      fs.writeFileSync(outFile, ck, 'utf-8');
      log(`Saved: ${outFile}`);
    } else {
      log('(empty)');
    }
    log('='.repeat(60));

    // ================================================================
    // 步骤 8 (可选): curl_cffi 请求测试
    // ================================================================
    if (DO_TEST && ck) {
      log('\n--- curl_cffi test ---');
      try {
        const pythonScript = `
import sys, re
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
import curl_cffi.requests as req
s = req.Session()
for p in ${JSON.stringify(ck)}.split(';'):
    p = p.strip()
    if '=' in p:
        k, v = p.split('=', 1)
        s.cookies.set(k.strip(), v.strip())
r = s.get('${TARGET_URL}', headers={'User-Agent': '${UA}'}, impersonate='chrome110', timeout=15)
print(f'Status: {r.status_code}, len={len(r.text)}')
if r.status_code == 200:
    t = re.search(r'<title>([^<]+)</title>', r.text)
    print(f'Title: {t.group(1) if t else \"(none)\"}')
    print('VERDICT: OK')
else:
    print('VERDICT: FAILED')
`;
        const result = execSync(`python -c "${pythonScript.replace(/"/g, '\\"')}"`, { encoding: 'utf-8', timeout: 30000 });
        log(result.trim());
      } catch (e) {
        log(`Test error: ${e.message}`);
      }
    }

    process.stdout.write(ck || '');
    process.exit(ck ? 0 : 1);
  }
}, 1000);

// Hard timeout
setTimeout(() => {
  const ck = win.document.cookie;
  log(`Force exit. Cookie: ${ck.length} chars`);
  process.stdout.write(ck || '');
  process.exit(0);
}, WAIT_SEC * 1000 + 8000);
