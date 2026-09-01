/**
 * align_window.js — 把沙箱 window 的可枚举 key 集合对齐到 jsdom (sdenv 实测 248 keys)
 *
 * 瑞数 VM 的指纹扫描 for-in 遍历 window, key 集合本身进指纹:
 *   - jsdom 有的 key 必须存在且可枚举
 *   - 我环境多余的 key 必须不可枚举 (或删除)
 *
 * 数据来源: probe_keys_sdenv.js 实测 Object.keys(window)
 */
'use strict';

// jsdom 可枚举 key 全集 (排除 sdenv 私有 _* 与 sdenv 自身 — 真实浏览器没有)
const JSDOM_ENUM_KEYS = `
CSSImportRule CSSMediaRule CSSRule CSSStyleDeclaration CSSStyleRule CSSStyleSheet
CanvasRenderingContext2D IDBFactory MediaList MediaQueryList Navigation Request
RTCPeerConnection StyleSheet VisualViewport XPathEvaluator XPathExpression
XPathResult Worker
addEventListener alert atob blur btoa cancelAnimationFrame cancelIdleCallback
captureEvents chrome clearInterval clearTimeout clientInformation close closed
confirm createImageBitmap crypto customElements devicePixelRatio document
external fetch find focus frameElement frames getComputedStyle getScreenDetails
getSelection history indexedDB innerHeight innerWidth isSecureContext length
localStorage location locationbar matchMedia menubar moveBy moveTo name navigation
navigator open opener origin outerHeight outerWidth pageXOffset pageYOffset parent
performance personalbar postMessage print prompt queryLocalFonts queueMicrotask
releaseEvents reportError requestAnimationFrame requestIdleCallback resizeBy
resizeTo screen screenLeft screenTop screenX screenY scroll scrollBy scrollTo
scrollX scrollY scrollbars self sessionStorage setInterval setTimeout
showDirectoryPicker showOpenFilePicker showSaveFilePicker status statusbar stop
structuredClone styleMedia toolbar top visualViewport
webkitCancelAnimationFrame webkitRequestAnimationFrame webkitRequestFileSystem
webkitResolveLocalFileSystemURL window
`.trim().split(/\s+/);

// on* 事件处理器 (jsdom 全部可枚举, 值 null)
const ON_EVENTS = `
abort afterprint auxclick beforeinput beforematch beforeprint beforetoggle
beforeunload blur cancel canplay canplaythrough change click close contextlost
contextmenu contextrestored copy cuechange cut dblclick drag dragend dragenter
dragleave dragover dragstart drop durationchange emptied ended error focus
formdata gotpointercapture hashchange input invalid keydown keypress keyup
languagechange load loadeddata loadedmetadata loadstart lostpointercapture
message messageerror mousedown mouseenter mouseleave mousemove mouseout
mouseover mouseup offline online pagehide pageshow paste pause play playing
pointercancel pointerdown pointerenter pointerleave pointermove pointerout
pointerover pointerrawupdate pointerup popstate progress ratechange
rejectionhandled reset resize scroll scrollend securitypolicyviolation seeked
seeking select slotchange stalled storage submit suspend timeupdate toggle
touchcancel touchend touchmove touchstart unhandledrejection unload
volumechange waiting webkitanimationend webkitanimationiteration
webkitanimationstart webkittransitionend wheel
`.trim().split(/\s+/).map(e => 'on' + e);

// 各 key 的值来源
const HOST_KEYS = new Set([
  // Node 24 context 内建与 jsdom 同构 (删除我的覆盖后从宿主取回)
  'Blob', 'File', 'FileList', 'FormData', 'URL', 'URLSearchParams',
  'EventTarget', 'MessageChannel', 'BroadcastChannel',
]);
const NULL_KEYS = new Set(['opener', ...ON_EVENTS]);
// ★ jsdom 实测默认值 (sdenv trace Task 1233-1449 核对):
//   closed=false isSecureContext=false status='' devicePixelRatio=1 视口=1024x768
//   event/_currentEvent = undefined (jsdom 无此属性 — 绝不能设 null/0!)
const VALUE_DEFAULTS = {
  closed: false, isSecureContext: false, status: '',
  devicePixelRatio: 1,
  innerWidth: 1024, innerHeight: 768, outerWidth: 1024, outerHeight: 768,
};
const METHOD_KEYS = new Set(`
addEventListener alert blur cancelAnimationFrame cancelIdleCallback captureEvents
clearInterval clearTimeout close confirm createImageBitmap find focus
getScreenDetails getSelection moveBy moveTo open postMessage print prompt
queryLocalFonts queueMicrotask releaseEvents reportError requestAnimationFrame
requestIdleCallback resizeBy resizeTo scroll scrollBy scrollTo showDirectoryPicker
showOpenFilePicker showSaveFilePicker stop structuredClone
webkitCancelAnimationFrame webkitRequestAnimationFrame webkitRequestFileSystem
webkitResolveLocalFileSystemURL removeEventListener
`.trim().split(/\s+/));
const STUB_KEYS = new Set(`
chrome customElements external locationbar menubar personalbar scrollbars
statusbar styleMedia toolbar navigation visualViewport clientInformation
screen
`.trim().split(/\s+/));
const VALUE_KEYS = new Set(`
closed devicePixelRatio innerHeight innerWidth isSecureContext length
outerHeight outerWidth pageXOffset pageYOffset screenLeft screenTop screenX
screenY scrollX scrollY status
`.trim().split(/\s+/));

function makeNativeFn(name) {
  const fn = function () {};
  Object.defineProperty(fn, 'name', { value: name, configurable: true });
  Object.defineProperty(fn, 'toString', {
    value: () => `function ${name}() { [native code] }`,
  });
  return fn;
}

// class 形态构造器 (jsdom 实测: 'class WebSocket extends ...')
function makeClassStub(name, src) {
  const C = class {};
  Object.defineProperty(C, 'name', { value: name, configurable: true });
  Object.defineProperty(C, 'toString', {
    value: () => src || `class ${name} { [native code] }`,
  });
  return C;
}

/**
 * @param {object} win 沙箱 global
 * @param {object} host Node 宿主 globalThis (取内建类)
 */
function alignWindowKeys(win, host) {
  const defRO = (k, v, enumerable) => {
    try {
      Object.defineProperty(win, k, {
        get: () => v, configurable: true, enumerable,
      });
    } catch (e) { win[k] = v; }
  };
  const def = (k, v, enumerable) => {
    try {
      Object.defineProperty(win, k, { value: v, writable: true, configurable: true, enumerable });
    } catch (e) { win[k] = v; }
  };

  // 1. jsdom 枚举集补齐 (含 on* 事件)
  const need = new Set([...JSDOM_ENUM_KEYS, ...ON_EVENTS]);
  for (const k of need) {
    if (Object.prototype.hasOwnProperty.call(win, k)) continue;
    if (NULL_KEYS.has(k)) { def(k, null, true); continue; }
    if (METHOD_KEYS.has(k)) { def(k, makeNativeFn(k), true); continue; }
    if (STUB_KEYS.has(k)) {
      if (k === 'clientInformation') { defRO(k, win.navigator, true); continue; }
      def(k, {}, true); continue;
    }
    if (VALUE_KEYS.has(k)) {
      const v = Object.prototype.hasOwnProperty.call(VALUE_DEFAULTS, k) ? VALUE_DEFAULTS[k]
        : (win[k] === undefined ? 0 : win[k]);
      def(k, v, true); continue;
    }
    if (HOST_KEYS.has(k) && host[k] !== undefined) { def(k, host[k], true); continue; }
    // Request: jsdom 形态 function Request() { [native code] } (length=1) + prototype.clone 可枚举
    //   (VM 任务 0-123 检测 Request.prototype.clone — 没有真实 Fetch 原型就提前 return)
    if (k === 'Request') {
      const R = makeNativeFn('Request');
      try { Object.defineProperty(R, 'length', { value: 1, configurable: true }); } catch (e) {}
      R.prototype.clone = makeNativeFn('clone');
      def(k, R, true);
      continue;
    }
    // WebSocket: jsdom 形态 class WebSocket extends ... (不用 Node undici 的 _WebSocket)
    if (k === 'WebSocket') {
      def(k, makeClassStub('WebSocket', 'class WebSocket extends EventTarget { [native code] }'), true);
      continue;
    }
    // CSS* 构造器等: native class 形态
    def(k, makeNativeFn(k), true);
  }


  if (process.env.ALIGN_PROBE) {
    try {
      const __r=[]; for(const __k in win){__r.push(__k); if(__r.length>600)break;}
      console.error('[ALIGN-PROBE] ' + process.env.ALIGN_PROBE + ' hasProto=' + __r.includes('removeEventListener'));
    } catch (__e) { console.error('[ALIGN-PROBE] err ' + __e.message); }
  }

  // 2. 我的多余 key → 不可枚举 (保留值, 直接读取仍可用)
  const mine = Object.keys(win);
  for (const k of mine) {
    if (need.has(k)) continue;
    if (k === '$_ts' || k.startsWith('__') || k === 'document') continue;
    if (k === 'WebSocket') {
      // jsdom: non-enumerable class WebSocket extends ... (Node undici 类名 _WebSocket 会泄露)
      def(k, makeClassStub('WebSocket', 'class WebSocket extends EventTarget { [native code] }'), false);
      continue;
    }
    if (HOST_KEYS.has(k)) {
      // 从宿主恢复内建 (jsdom 里这些是 non-enumerable 内建)
      if (host[k] !== undefined) { def(k, host[k], false); continue; }
      delete win[k]; continue;
    }
    if (['AudioContext', 'webkitAudioContext', 'OfflineAudioContext',
      'attachEvent', 'detachEvent', 'webkitIndexedDB',
      'webkitRTCPeerConnection'].includes(k)) {
      delete win[k]; continue;
    }
    // ★ event/_currentEvent: jsdom 无此属性 (S 侧 typeof=undefined) — N 侧被 VM chunk 写入
    //   null/0 → typeof 检查分叉 (Task 1233/1347) → 直接删除 (读取得 undefined 对齐)
    if (k === 'event' || k === '_currentEvent') {
      try { delete win[k]; } catch (e) {}
      continue;
    }
    // dispatchLoad/dispatchEvent 是我的执行器自用/VM 会调用 — 只降为不可枚举
    if (k === 'dispatchLoad' || k === 'dispatchEvent') {
      try {
        const desc = Object.getOwnPropertyDescriptor(win, k);
        if (desc && desc.configurable) {
          Object.defineProperty(win, k, { ...desc, enumerable: false });
        }
      } catch (e) {}
      continue;
    }
    try {
      const desc = Object.getOwnPropertyDescriptor(win, k);
      if (desc && desc.configurable) {
        Object.defineProperty(win, k, { ...desc, enumerable: false });
      }
    } catch (e) {}
  }


  if (process.env.ALIGN_PROBE) {
    try {
      const __r=[]; for(const __k in win){__r.push(__k); if(__r.length>600)break;}
      console.error('[ALIGN-PROBE] ' + process.env.ALIGN_PROBE + ' hasProto=' + __r.includes('removeEventListener'));
    } catch (__e) { console.error('[ALIGN-PROBE] err ' + __e.message); }
  }

  // 3. window 自身的 toStringTag (parent/self/top 读成 [object Window])
  try {
    Object.defineProperty(win, Symbol.toStringTag, { value: 'Window', configurable: true });
  } catch (e) {}


  if (process.env.ALIGN_PROBE) {
    try {
      const __r=[]; for(const __k in win){__r.push(__k); if(__r.length>600)break;}
      console.error('[ALIGN-PROBE] ' + process.env.ALIGN_PROBE + ' hasProto=' + __r.includes('removeEventListener'));
    } catch (__e) { console.error('[ALIGN-PROBE] err ' + __e.message); }
  }

  if (process.env.ALIGN_NO4) return;
  // 4. ★ 按 sdenv 实测顺序重建枚举顺序 (VM 的 Bdbox_ 收集函数时 for-in 顺序进指纹!)
  //    sdenv: StyleSheet 第一, $_ts@247, VM 全局最后; nodenv 原来 $_ts@0 → 指纹分叉
  try {
    const { SDENV_ORDER, SDENV_CLASS_SRC, SDENV_TYPES } = require('./align_order.js');
    const save = {}; // key -> descriptor (保留 getter/value 形态!)
    // ★ 用 getOwnPropertyNames (含不可枚举) — step2 已把 _sdGlobalObject 等降为非枚举,
    //   Object.keys 会漏掉它们的描述符 → 重建后变 null 默认值
    const currKeys = Object.getOwnPropertyNames(win);
    for (const k of currKeys) {
      try { save[k] = Object.getOwnPropertyDescriptor(win, k); } catch (e) {}
    }
    // 11 个 CSS/XPath 类: 用 jsdom 真实源码构造 (sdenv 非 native)
    const makeFromSrc = (name, src) => {
      const C = function () {};
      Object.defineProperty(C, 'name', { value: name, configurable: true });
      Object.defineProperty(C, 'toString', { value: () => src, configurable: true });
      C.prototype.constructor = C;
      return C;
    };
    for (const [name, src] of Object.entries(SDENV_CLASS_SRC)) {
      // ★★★ 2026-08-19 修复 (task 878/884/890/893/896/881): 之前误用 makeNativeFn →
      //   'function X() { [native code] }' vs jsdom 真实源码 (SDENV_CLASS_SRC 有 src) — 分叉!
      // ★★★ task 899/902/905: 覆盖会重置 length (makeFromSrc 空函数 length=0) —
      //   XPathExpression/XPathResult=3, CSSStyleDeclaration=1 (jsdom 参数个数) — 保留原 length!
      const prev = save[name] && save[name].value;
      const f = makeFromSrc(name, src);
      if (typeof prev === 'function' && prev.length > 0) {
        try { Object.defineProperty(f, 'length', { value: prev.length, configurable: true }); } catch (e) {}
      }
      save[name] = { value: f, writable: true, configurable: true, enumerable: true };
    }
    // sdenv 有但 nodenv 没有的键: 按类型补默认值
    // ★ 只补真正不存在的键 — 被代理 ownKeys 排除 (window/self/top/frames/_ 前缀)
    //   的键在 ctx 上仍存在, 补默认值会覆盖成 null!
    // ★ _$/$ 前缀 = 每轮随机的 VM 全局名 (旧轮的 sdenv 捕获名单) — 绝不补桩!
    for (const k of SDENV_ORDER) {
      if (k.charAt(0) === '_' && k.charAt(1) === '$') continue;
      if (k.charAt(0) === '$' || k === 't') continue;
      if (!(k in save) && !Object.prototype.hasOwnProperty.call(win, k)) {
        const t = SDENV_TYPES[k];
        let v;
        if (t === 'function') v = makeNativeFn(k);
        else if (t === 'string') v = '';
        else if (t === 'number') v = 0;
        else if (t === 'boolean') v = false;
        // ★★★ 2026-08-19 修复 (task 1229/1343/1433): undefined 类型补 undefined (jsdom 读不存在键),
        //   object 类型补 {} (sdenv 键 = sdenv 框架对象) — 之前全落 null → VM 读值分叉
        else if (t === 'undefined') v = undefined;
        else if (t === 'object') v = {};
        else v = null;
        save[k] = { value: v, writable: true, configurable: true, enumerable: true };
      }
    }
    // 删除全部可枚举键 (不可枚举的保留原位, 不影响 for-in 顺序)
    for (const k of currKeys) {
      const d = save[k] || Object.getOwnPropertyDescriptor(win, k);
      if (d && !d.enumerable) continue; // 不可枚举: 跳过
      try { delete win[k]; } catch (e) {}
    }
    // sdenv 顺序重建; sdenv 没有的 nodenv 自有可枚举键排在最后 (与 jsdom 同构: 降为不可枚举)
    const extra = Object.keys(save).filter(k => !SDENV_ORDER.includes(k) && save[k] && save[k].enumerable);
    for (const k of SDENV_ORDER) {
      const d = save[k];
      if (!d) continue;
      try { Object.defineProperty(win, k, { ...d, enumerable: true }); } catch (e) { try { win[k] = d.value; } catch (e2) {} }
    }
    // ★★★ 2026-08-19 权威对齐 (S 段1 数组 240 键实证): sdenv-extend windowGetterUndefinedKeys
    //   24 键 + window/frames/self/top 4 键 (WinKeys get→realm.win → 收集器自引用跳过) →
    //   S 收集器数组无此 28 键; parent 保留 (值=jsdom 本体, 非自引用) → enum:TRUE
    //   数据: sdenv_extend_key_filter = windowGetterUndefinedKeys (sdenv-extend-cjs.js:2121) + WinKeys 交集
    const SDENV_HIDDEN_KEYS = new Set([
      '_top', '_parent', '_length', '_globalObject', '_sdGlobalObject', '_globalProxy',
      '_registeredHandlers', '_eventHandlers', '_resourceLoader', '_document', '_origin',
      '_sessionHistory', '_virtualConsole', '_runScripts', '_frameElement',
      '_pretendToBeVisual', '_storageQuota', '_commonForOrigin', '_currentOriginData',
      '_localStorage', '_sessionStorage', '_selection', '_customElementRegistry',
      'loadTextSync', 'window', 'frames', 'self', 'top',
    ]);
    for (const k of SDENV_HIDDEN_KEYS) {
      const d = save[k];
      if (!d) continue;
      try { Object.defineProperty(win, k, { ...d, enumerable: false }); } catch (e) {}
    }
    for (const k of extra) {
      const d = save[k];
      try { Object.defineProperty(win, k, { ...d, enumerable: false }); } catch (e) {}
    }

  if (process.env.ALIGN_PROBE) {
    try {
      const __r=[]; for(const __k in win){__r.push(__k); if(__r.length>600)break;}
      console.error('[ALIGN-PROBE] ' + process.env.ALIGN_PROBE + ' hasProto=' + __r.includes('removeEventListener'));
    } catch (__e) { console.error('[ALIGN-PROBE] err ' + __e.message); }
  }

  } catch (e) { /* 顺序对齐失败不影响主流程 */ }
}

module.exports = { alignWindowKeys };
