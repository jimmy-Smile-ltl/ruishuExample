/**
 * env.js — 手写 Node 浏览器环境 (零依赖, RS6.js 风格)
 *
 * 设计:
 *   - 递归 safeMock: 既是函数又是对象, 任何访问都不返回 undefined
 *     (返回 undefined 会暴露环境差异, 被瑞数 VM 检测)
 *   - --debug 模式记录 [API]/[CALL]/[SET], 用于发现 VM 访问面并定向补充
 *   - 关键对象手工精调 (navigator/screen/document/canvas), 其余用 safeMock
 *
 * 用法:
 *   const { buildEnv } = require('./env.js');
 *   const { win, doc } = buildEnv({ url, ua, nsd, cd, metaId, metaContent, scriptSrc, debug });
 */
'use strict';

// ★★★ 沙箱 realm fakePTS 安装器 (2026-08-19): buildEnv 内定义, 模块级导出供 run_vm.js
let installFakePTS = null;

function buildEnv(opts = {}) {
  const {
    url = 'https://example.com/',
    ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    nsd = 0,
    cd = '',
    metaId = '',
    metaContent = '',
    scriptSrc = '',
    inlineScripts = [],
    debug = false,
    fixDateMs = 0,
  } = opts;

  // ★★★ fakePTS 机制 (2026-08-19): 让 env.js 伪造函数呈现与 jsdom 完全一致的 toString
  //   VM 用 Function.prototype.toString.call(fn) 绕过 own toString 读 [[SourceText]] —
  //   JS 伪造函数永远返回源码 → 与 jsdom 的原生/class 形态分叉 → cookie 内容不同 → 400
  //   方案: 替换沙箱 Function.prototype.toString, 三分支:
  //     1) B 函数 (ctxFunction 产物, __anonSrc) → 'function anonymous(...)'
  //     2) NATIVE_FNS (显式原生伪装: makeNative + S 侧为 native 的 window API) → 'function X() { [native code] }'
  //     3) ENV_FNS 且 JS_TEXT 查表命中 (jsdom JS 源码文本: class/方法完整源码) → jsdom 原文
  //     4) 兜底 origPTS (VM 自己的函数/沙箱内置 — 与 jsdom 一致)
  const NATIVE_FNS = new WeakSet();
  const ENV_FNS = new WeakSet();
  let JS_TEXT = {};
  try { JS_TEXT = require('./jsdom_texts.json');
  // timer 4 键已从 NATIVE_NAMES 移除, JS_TEXT 残留会命中 ENV_FNS 分支 -> 删除
  try { delete JS_TEXT['setTimeout']; delete JS_TEXT['setInterval'];
        delete JS_TEXT['clearTimeout']; delete JS_TEXT['clearInterval']; } catch (e1) {}
} catch (e) {}
  // S 侧为原生形态的 window API 名单 (probe7 实测: jsdom 'N' 项)
  const NATIVE_NAMES = new Set([
    'open', 'close', 'alert', 'confirm', 'prompt', 'print', 'postMessage', 'scrollTo', 'scrollBy',
    'scroll', 'focus', 'blur', 'stop', 'find', 'reportError', 'moveBy', 'moveTo', 'resizeBy', 'resizeTo',
    'atob', 'btoa', 'matchMedia', 'getComputedStyle', 'getSelection', 'requestAnimationFrame',
    'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'createImageBitmap',
    'structuredClone', 'queueMicrotask', 'clearTimeout', 'clearInterval',
    'fetch', 'eval', 'addEventListener', 'captureEvents', 'releaseEvents', 'getScreenDetails',
    'queryLocalFonts', 'showDirectoryPicker', 'showOpenFilePicker', 'showSaveFilePicker',
    'webkitRequestAnimationFrame', 'webkitCancelAnimationFrame', 'webkitRequestFileSystem',
    'webkitResolveLocalFileSystemURL', 'Event', 'Worker', 'IDBFactory', 'Request', 'Navigation',
    'CSSStyleDeclaration', 'HTMLCanvasElement', 'MediaQueryList', 'RTCPeerConnection',
    'VisualViewport', 'CanvasRenderingContext2D',
  ]);
  // ★ getter 统一标记: jsdom WebIDL getter 显示 'function get() { [native code] }'
  const makeGetter = (fn) => {
    try { Object.defineProperty(fn, 'name', { value: 'get', configurable: true }); } catch (e) {}
    NATIVE_FNS.add(fn);
    return fn;
  };

  const log = debug
    ? (msg) => process.stderr.write(`  ${msg}\n`)
    : () => {};

  // ================================================================
  // 递归 safeMock
  // ================================================================
  const seenSet = new Set();
  function createRecursiveMock(name = '') {
    const handler = {
      get(target, prop) {
        if (prop === Symbol.toPrimitive) return () => name || '';
        if (prop === 'toString') return () => `[mock ${name}]`;
        if (prop === 'valueOf') return () => 0;
        if (prop === Symbol.iterator) return function* () { };
        if (typeof prop === 'symbol') return undefined;
        if (debug && typeof prop === 'string' && !prop.startsWith('_')) {
          const key = `${name}.${prop}`;
          if (!seenSet.has(key)) {
            seenSet.add(key);
            log(`[API] ${key}`);
          }
        }
        return createRecursiveMock(name ? `${name}.${String(prop)}` : String(prop));
      },
      apply(target, thisArg, args) {
        if (debug && name) log(`[CALL] ${name}(${(args || []).length} args)`);
        return createRecursiveMock(name);
      },
      set(target, prop, value) {
        target[prop] = value;
        if (debug) log(`[SET] ${name}.${String(prop)} = ${String(value).substring(0, 40)}`);
        return true;
      },
    };
    const fn = function () { return createRecursiveMock(name); };
    return new Proxy(fn, handler);
  }

  // ================================================================
  // 全局窗口 — ★ 优先使用传入的干净沙箱 (vm.createContext), 隔离 Node 内建
  // ================================================================
  const win = opts.win || globalThis;
  const setGlobal = (key, value) => {
    try {
      // ★ enumerable: true — jsdom 的 window 属性大多可枚举 (VM 可能 for-in 扫 window)
      Object.defineProperty(win, key, { value, writable: true, configurable: true, enumerable: true });
    } catch (e) {
      win[key] = value;
    }
    // ★ fakePTS 标记: 函数 → ENV_FNS; S 侧为原生形态的名字 → NATIVE_FNS
    if (typeof value === 'function') {
      ENV_FNS.add(value);
      try { if (!value.__natName && key !== 'setTimeout' && key !== 'setInterval')
          Object.defineProperty(value, '__natName', { value: key, configurable: true }); } catch (e2) {}
      if (NATIVE_NAMES.has(key)) NATIVE_FNS.add(value);
    }
  };
  // ★ 只读全局 (浏览器/jsdom: 赋值静默失败 — VM 会写这些属性探测环境)
  const setGlobalRO = (key, value) => {
    try {
      Object.defineProperty(win, key, { get: () => value, configurable: true, enumerable: true });
    } catch (e) { win[key] = value; }
    if (typeof value === 'function') {
      ENV_FNS.add(value);
      try { if (!value.__natName && key !== 'setTimeout' && key !== 'setInterval')
          Object.defineProperty(value, '__natName', { value: key, configurable: true }); } catch (e2) {}
      if (NATIVE_NAMES.has(key)) NATIVE_FNS.add(value);
    }
  };

  // ★ native 形态伪装: 不定义 own toString! (jsdom 类/方法无 own toString,
  //   String(fn) 走原型 → fakePTS 按 name 查表/标记返回精确文本)
  const makeNative = (name, src) => {
    const fn = function () { };
    Object.defineProperty(fn, 'name', { value: name, configurable: true });
    NATIVE_FNS.add(fn); // ★ fakePTS 分支 (prototype.toString.call 绕过 own)
    return fn;
  };
  // ★ Symbol.toStringTag: 浏览器对象的 [object X] 形态 (jsdom 实测: Navigator/Screen/...)
  const withTag = (obj, tag) => {
    try { Object.defineProperty(obj, Symbol.toStringTag, { value: tag, configurable: true }); } catch (e) {}
    return obj;
  };
  // ★ CSSStyleDeclaration (jsdom 形态: 可构造类, el.style 为其实例)
  const _cssStyleProto = {
    cssText: '',
    getPropertyValue() { return ''; },
    setProperty() { },
    removeProperty() { return ''; },
    item() { return ''; },
    length: 0,
  };
  try { Object.defineProperty(_cssStyleProto, Symbol.toStringTag, { value: 'CSSStyleDeclaration', configurable: true }); } catch (e) {}
  try {
    const _cssCtor = makeNative('CSSStyleDeclaration', 'class CSSStyleDeclaration { [native code] }');
    _cssCtor.prototype = _cssStyleProto;
    Object.defineProperty(_cssStyleProto, 'constructor', { value: _cssCtor, configurable: true, writable: true });
    // ★★★ 2026-08-19 修复 (task 899): length 必须在块内设! 块外引用 const → ReferenceError
    //   被外层 catch 静默吞掉 → N=0 vs jsdom S=1 (jsdom 构造器声明 1 参数) → 指纹分叉
    try { Object.defineProperty(_cssCtor, 'length', { value: 1, configurable: true }); } catch (e2) {}
    setGlobal('CSSStyleDeclaration', _cssCtor);
  } catch (e) {}
  // ★ HTMLCollection-like 集合 (jsdom 返回 HTMLCollection, 不是裸数组)
  const makeCollection = (arr) => {
    const coll = nativeifyMethods({
      length: arr.length,
      item(i) { return arr[i] || null; },
      namedItem(n) { return null; },
    });
    arr.forEach((el, i) => { coll[i] = el; });
    return coll;
  };
  // ★ DOM 原型链 (jsdom 元素 instanceof HTMLXxxElement 为 true, 指纹检查点)
  const buildProtoChain = () => {
    const mkProto = (name, parent) => {
      const p = parent ? Object.create(parent) : {};
      const ctor = makeNative(name, `function ${name}() { [native code] }`);
      ctor.prototype = p;
      Object.defineProperty(p, 'constructor', { value: ctor, configurable: true, writable: true });
      // ★ [object HTMLXxxElement] 形态 (jsdom 实测) — String(el) 进 codegen 指纹
      try { Object.defineProperty(p, Symbol.toStringTag, { value: name, configurable: true }); } catch (e) {}
      return { proto: p, ctor };
    };
    const node = mkProto('Node', null);
    const elem = mkProto('Element', node.proto);
    const htmlEl = mkProto('HTMLElement', elem.proto);
    const tags = ['HTMLFormElement', 'HTMLInputElement', 'HTMLCanvasElement', 'HTMLAnchorElement',
      'HTMLDivElement', 'HTMLImageElement', 'HTMLVideoElement', 'HTMLAudioElement',
      'HTMLScriptElement', 'HTMLMetaElement', 'HTMLHeadElement', 'HTMLBodyElement',
      'HTMLHtmlElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLButtonElement'];
    const map = {
      NODE: node, ELEMENT: elem, HTMLELEMENT: htmlEl,
      form: htmlEl, input: htmlEl, canvas: htmlEl, a: htmlEl, div: htmlEl, img: htmlEl,
      video: htmlEl, audio: htmlEl, script: htmlEl, meta: htmlEl, head: htmlEl, body: htmlEl,
      html: htmlEl, select: htmlEl, textarea: htmlEl, button: htmlEl,
    };
    for (const tn of tags) {
      // HTMLFormElement → form, HTMLInputElement → input, ...
      const t = tn.replace(/^HTML/, '').replace(/Element$/, '').toLowerCase();
      const e = mkProto(tn, htmlEl.proto);
      map[t] = e;
      map[tn] = e;
    }
    // ★ 'a' → HTMLAnchorElement (初始 map 里 a 指向 htmlEl — 修正!)
    map.a = map.anchor;
    // document 原型
    const docNode = mkProto('Document', node.proto);
    try { Object.defineProperty(docNode.proto, Symbol.toStringTag, { value: 'Document', configurable: true }); } catch (e) {}
    return { map, docProto: docNode.proto, docCtor: docNode.ctor };
  };
  const _pchain = buildProtoChain();
  // ★ Document.prototype.readyState: jsdom accessor (Task 1577 分叉:
  //   getOwnPropertyDescriptor(Document.prototype, 'readyState') N=undefined vs S=[o]getter →
  //   N 侧任务提前 return (72 vs 116 行)!) — getter 调用返回标记字符串 →
  //   VM 用返回值做 localStorage.getItem 键 → null → 检查通过
  try {
    Object.defineProperty(_pchain.docProto, 'readyState', {
      get: makeGetter(function () { return 'complete'; }),
      set: function () {},
      enumerable: true, configurable: true,
    });
  } catch (e) {}
  // ★ HTMLFormElement.prototype 对齐 jsdom 15 键 (for...in 采样; jsdom 实测 14 可枚举 + constructor)
  {
    const fp = _pchain.map.form.proto;
    if (fp) {
      const formDefaults = {
        method: 'get',
        enctype: 'application/x-www-form-urlencoded',
        acceptCharset: '', name: '', target: '', noValidate: false,
      };
      for (const [k, v] of Object.entries(formDefaults)) {
        try { Object.defineProperty(fp, k, { value: v, writable: true, enumerable: true, configurable: true }); } catch (e) {}
      }
      for (const m of ['submit', 'requestSubmit', 'reset', 'checkValidity', 'reportValidity']) {
        try {
          const f = makeNative(m, `function ${m}() { [native code] }`);
          Object.defineProperty(fp, m, { value: f, writable: true, enumerable: true, configurable: true });
        } catch (e) {}
      }
      // length/elements: jsdom 原型 accessor 动态读控件 (实例零键)
      const _controlsOf = (f) => (f.children || []).filter(c =>
        ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(c.tagName));
      try {
        Object.defineProperty(fp, 'length', { get() { return _controlsOf(this).length; }, enumerable: true, configurable: true });
        Object.defineProperty(fp, 'elements', { get() { return makeCollection(_controlsOf(this)); }, enumerable: true, configurable: true });
      } catch (e) {}
    }
  }
  const _protoFor = (tag) => {
    const t = (tag || '').toLowerCase();
    return (_pchain.map[t] || _pchain.map.HTMLELEMENT).proto;
  };
  // 全局构造器 (jsdom window 上都有)
  for (const tn of ['Node', 'Element', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement',
    'HTMLCanvasElement', 'HTMLAnchorElement', 'HTMLDivElement', 'HTMLImageElement',
    'HTMLVideoElement', 'HTMLAudioElement', 'HTMLScriptElement', 'HTMLMetaElement',
    'HTMLHeadElement', 'HTMLBodyElement', 'HTMLHtmlElement', 'HTMLSelectElement',
    'HTMLTextAreaElement', 'HTMLButtonElement', 'Document']) {
    const entry = tn === 'Document' ? _pchain.docCtor
      : (tn === 'Node' ? _pchain.map.NODE.ctor
        : tn === 'Element' ? _pchain.map.ELEMENT.ctor
          : tn === 'HTMLElement' ? _pchain.map.HTMLELEMENT.ctor
            : (_pchain.map[tn.replace(/^HTML/, '').replace(/Element$/, '').toLowerCase()] || _pchain.map.HTMLELEMENT).ctor);
    setGlobal(tn, entry);
  }
  const _setProto = (el, tag) => {
    try { Object.setPrototypeOf(el, _protoFor(tag)); } catch (e) { /* ignore */ }
    return el;
  };
  // ★ 把对象上的普通方法包装成 native 形态 (保持行为不变)
  const nativeifyMethods = (obj, names) => {
    if (!obj) return obj;
    for (const k of (names || Object.keys(obj))) {
      const v = obj[k];
      if (typeof v !== 'function' || v.__native) continue;
      if (k === 'constructor' || k === 'toString' || k === 'valueOf') continue;
      const wrapped = function (...args) {
        if (this === undefined || this === null) {
          if (globalThis.__envLog) globalThis.__envLog('[NULL-THIS] ' + k + ' 被以 undefined receiver 调用');
        }
        if (globalThis.__envLog && k === 'createElement') {
          var __vn = v.name, __va = typeof v.apply, __vd = null;
          try { var __o = Object.getOwnPropertyDescriptor(v, 'apply'); __vd = __o ? ('own:' + typeof __o.value + ':' + String(__o.value).slice(0, 50)) : 'proto'; } catch (__e2) { __vd = 'E'; }
          var __ks = []; try { for (var __kk in v) { __ks.push(__kk); if (__ks.length > 8) break; } } catch (__e3) {}
          globalThis.__envLog('[V2-PROBE] name=' + __vn + '|apply=' + __va + ':' + String(v.apply).slice(0, 50) + '|apd=' + __vd + '|keys=' + __ks.join(',') + '|j7=' + typeof v._$j7 + '|b3=' + typeof v._$b3 + '|args=' + (args && args[0]));
        }
        return Reflect.apply(v, this, args);
      };
      Object.defineProperty(wrapped, 'name', { value: k, configurable: true });
      NATIVE_FNS.add(wrapped); // fakePTS 查表/标记统一处理 (无 own toString, 与 jsdom 对齐)
      wrapped.__native = true;
      obj[k] = wrapped;
    }
    return obj;
  };

  const host = url.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  const proto = url.startsWith('https') ? 'https:' : 'http:';
  const origin = `${proto}//${host}`;
  const pathname = url.replace(origin, '').split('?')[0].split('#')[0] || '/';

  // ================================================================
  // Navigator
  // ================================================================
  setGlobalRO('navigator', withTag({

    // ★ 2026-08-19: UA 对齐回放链 (Windows Chrome/138) — cookie 指纹必须与请求头一致
    // ★★★ 2026-08-31 UA 对齐: sdenv/browser/chrome/navigator.js 强制 Mac/Chrome131
    //   (与 HTTP UA 无关! S 侧 E61 trace 实测: VM 编码 userAgent = Macintosh Chrome/131
    //   N 侧原 Windows/Chrome138 → 编码输入 111 vs 117 chars → cookie 材料分叉)
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    // ★ 2026-08-31 对齐 sdenv (Mac): appVersion 无 Mozilla/ 前缀
    appVersion: '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    // jsdom 实测: navigator own 上有 sendBeacon (fn, 可枚举, native 形态)
    sendBeacon: makeNative('sendBeacon', 'function sendBeacon() { [native code] }'),
    // sdenv connection getter (NetworkInformation 原型对象)
    connection: Object.assign(Object.create({ constructor: makeNative('NetworkInformation', 'function NetworkInformation() { [native code] }') }),
      { downlink: 3.85, effectiveType: '4g', onchange: null, rtt: 100, saveData: false }),
    // sdenv webkitPersistentStorage getter (DeprecatedStorageQuota 原型对象)
    webkitPersistentStorage: { queryUsageAndQuota() { }, requestQuota() { } },
    language: 'en-US',
    // ★ 2026-08-19: 对齐 sdenv 实测 (sdenv-jsdom navigator.languages = ["en-US","en"])
    //   VM headless 探测任务读 languages — 长度/内容差异 → 探测分支分叉 → P 值分叉 → 400
    languages: ['en-US', 'en'],
    cookieEnabled: true,
    // ★ 2026-08-31: webdriver 移到 Navigator 原型 (jsdom 实测: own 无 descriptor,
    //   原型 accessor e:true) — 实例自有键会被 0-306 任务 getOwnPropertyDescriptor 检测到 → 分叉
    hardwareConcurrency: 8,
    deviceMemory: 8,
    maxTouchPoints: 0,
    vendor: 'Google Inc.',
    vendorSub: '',
    productSub: '20030107',
    appCodeName: 'Mozilla',
    appName: 'Netscape',
    onLine: true,
    doNotTrack: null,
    // ★★★ 2026-08-31 jsdom 实测: plugins/mimeTypes = 空 PluginArray (length=0)!
    //   旧 5 插件/4 mime 项 → VM 遍历读 undefined 项 .toString → 异常 ×3 → P 生成链断
    plugins: {
      length: 0,
      item(i) { return null; },
      namedItem() { return null; },
      refresh() { },
    },
    mimeTypes: {
      length: 0,
      item(i) { return null; },
      namedItem() { return null; },
    },
  }, 'Navigator'));

  // ★ window.Navigator 构造函数 (jsdom 实测: class Navigator, prototype 19 个可枚举成员,
  //   自身 enumerable:false — for-in 跳过但 get 可读; 2026-08-19 分叉根因:
  //   op 19 读 window.Navigator → S 压栈 class Navigator, N 压栈 undefined → 分支分叉 → 400
  {
    const NavigatorCtor = class Navigator {
      constructor() { throw new TypeError('Illegal constructor'); }
    };
    // ★ class toString: jsdom 源码形态 (LF) — N 侧 env.js 是 CRLF 文件 → 行尾分叉 → __srcText 覆盖
    try { Object.defineProperty(NavigatorCtor, '__srcText', { value: JS_TEXT['Navigator'].text, configurable: true }); } catch (e4) {}
    // jsdom 实测顺序 (probe5): javaEnabled,appCodeName,appName,appVersion,platform,product,
    //   productSub,userAgent,vendor,vendorSub,language,languages,onLine,cookieEnabled,
    //   plugins,mimeTypes,hardwareConcurrency,webdriver,maxTouchPoints (19 个可枚举)
    const NAV_KEYS = ['javaEnabled', 'appCodeName', 'appName', 'appVersion', 'platform',
      'product', 'productSub', 'userAgent', 'vendor', 'vendorSub', 'language', 'languages',
      'onLine', 'cookieEnabled', 'plugins', 'mimeTypes', 'hardwareConcurrency', 'webdriver',
      'maxTouchPoints'];
    for (const k of NAV_KEYS) {
      if (k === 'javaEnabled') {
        // jsdom: javaEnabled 是方法 (返回 false), 不是 getter
        Object.defineProperty(NavigatorCtor.prototype, k, {
          value: function javaEnabled() { return false; },
          enumerable: true, configurable: true, writable: true,
        });
      } else if (k === 'webdriver') {
        // ★ 2026-08-31: 实例无自有 webdriver 键 (jsdom 对齐) — getter 直接返回 false,
        //   不能读 win.navigator[k] (会递归进原型 getter 自身);
        //   __srcText 覆盖 fakePTS (name='get' 会命中 JS_TEXT['get'] 查表返回 window.get 源码 → 分叉)
        const wdg = makeGetter(function () { return false; });
        try { Object.defineProperty(wdg, '__srcText', { value: 'function get() { [native code] }', configurable: true }); } catch (e) {}
        Object.defineProperty(NavigatorCtor.prototype, k, {
          get: wdg,
          enumerable: true, configurable: true,
        });
      } else {
        // jsdom 实测: prototype getter toString = 'function get() { [native code] }'
        //   (2026-08-19: VM 遍历 prototype 取 getter 函数 toString 检测 → JS 源码形态分叉)
        const g = makeGetter(function () { try { return win.navigator[k]; } catch (e) { return undefined; } });
        // (无 own toString — fakePTS 对 name='get'+NATIVE_FNS 返回相同文本)
        Object.defineProperty(NavigatorCtor.prototype, k, {
          get: g,
          enumerable: true, configurable: true,
        });
      }
    }
    // navigator 实例补 javaEnabled (jsdom 实测: navigator own 无, prototype 方法)
    try {
      if (typeof win.navigator.javaEnabled !== 'function') {
        Object.defineProperty(win.navigator, 'javaEnabled', {
          value: function javaEnabled() { return false; },
          enumerable: true, configurable: true, writable: true,
        });
      }
    } catch (e) {}
    // ★ enumerable:false — jsdom 实测 Navigator 不在 for-in window (不可枚举)
    Object.defineProperty(win, 'Navigator', {
      value: NavigatorCtor, writable: true, configurable: true, enumerable: false,
    });
    // ★★★ 2026-08-31: navigator 实例挂 NavigatorCtor.prototype (jsdom 对齐 —
    //   0-306 任务 Object(navigator).constructor 检测: N=Object vs S=Navigator → 分叉)
    try { Object.setPrototypeOf(win.navigator, NavigatorCtor.prototype); } catch (e) {}
    log('[ENV] Navigator class: proto ' + NAV_KEYS.length + ' keys, enum=false');
  }

  // ================================================================
  // Screen — 对齐 sdenv/jsdom 实测值
  // ================================================================
  setGlobalRO('screen', withTag({
    width: 0, height: 0, availWidth: 0, availHeight: 0,
    availLeft: undefined, availTop: undefined,
    colorDepth: 24, pixelDepth: 24,
    orientation: { type: 'landscape-primary', angle: 0, onchange: null },
  }, 'Screen'));

  // ================================================================
  // Location (★ 拦截 redirect)
  // ================================================================
  // ★ jsdom 对齐版 location: proto 14 个(assign/replace/constructor 不可枚举)
  //    for...in 11 个 = reload, href, toString, origin, protocol, host, hostname, port, pathname, search, hash
  //    ★ 无 ancestorOrigins / valueOf(jsdom 没有)
  {
    const locProto = {};
    // ★★★ 2026-08-19 修复 (task 872): jsdom location 方法是 native 形态
    //   ('function replace() { [native code] }') — 匿名函数源码形态 → 分叉
    //   __natName → fakePTS 查表 JS_TEXT['replace'] 或兜底 native 文本; name 属性对齐
    const locMark = (fn, nm) => {
      try { Object.defineProperty(fn, 'name', { value: nm, configurable: true }); } catch (e2) {}
      try { Object.defineProperty(fn, '__natName', { value: nm, configurable: true }); } catch (e2) {}
      return fn;
    };
    const locDefs = [
      ['constructor', function Location() {}],
      ['assign', locMark(function () {}, 'assign')],
      ['replace', locMark(function (newUrl) { log(`[BLOCKED] location.replace → ${newUrl}`); }, 'replace')],
      ['reload', locMark(function () {}, 'reload')],
      ['href', url],
      ['toString', function () { return url; }],
      ['origin', origin],
      ['protocol', proto],
      ['host', host],
      ['hostname', host],
      ['port', ''],
      ['pathname', pathname],
      ['search', ''],
      ['hash', ''],
    ];
    for (const [k, v] of locDefs) locProto[k] = v;
    Object.defineProperties(locProto, {
      constructor: { value: function Location() {}, enumerable: false },
      assign: { value: locMark(function () {}, 'assign'), enumerable: false },
      replace: { value: locMark(function (newUrl) { log(`[BLOCKED] location.replace → ${newUrl}`); }, 'replace'), enumerable: false },
    });
    const loc = Object.create(locProto);
    setGlobalRO('location', withTag(loc, 'Location'));
  }
  // ★ window.origin: jsdom/浏览器 IDL 只读属性 (返回 location.origin 字符串) —
  //   VM chunk 运行期会写入 window.origin=函数 (任务 1335 typeof 探测) —
  //   jsdom 只读 getter 赋值静默失败 → S 侧保持字符串; N 侧没定义→被 chunk 写入函数 → 分叉!
  setGlobalRO('origin', origin);
  setGlobalRO('history', withTag({
    length: 3, state: null, scrollRestoration: 'auto',
    pushState() { }, replaceState() { }, back() { }, forward() { }, go() { },
  }, 'History'));
  // ★ history 方法 toString: jsdom WebIDL 源码形态 (LF) — VM 读 toString 分叉修复
  for (const k of ['pushState', 'replaceState', 'back', 'forward', 'go']) {
    try { if (JS_TEXT[k]) Object.defineProperty(win.history[k], '__srcText', { value: JS_TEXT[k].text, configurable: true }); } catch (e4) {}
  }

  // ================================================================
  // DOM 树: meta + script + head + body
  // ================================================================
  let metaEl = nativeifyMethods({
    nodeType: 1, nodeName: 'META', tagName: 'META',
    // IDL 属性 (浏览器中 meta.content / meta.id 直接可读)
    content: metaContent,
    id: metaId,
    getAttribute(name) {
      if (name === 'r') return 'm';
      if (name === 'content') return metaContent;
      if (name === 'id') return metaId;
      return null;
    },
    hasAttribute(name) { return ['r', 'content', 'id'].includes(name); },
    attributes: {
      r: { value: 'm', name: 'r' },
      content: { value: metaContent, name: 'content' },
      id: { value: metaId, name: 'id' },
      length: 3, item() { return null; },
    },
    getElementsByTagName() { return makeCollection([]); },
    childNodes: [], children: [],
    parentNode: null, parentElement: null,
    removeChild(c) { return c; }, insertBefore() { }, replaceChild() { },
  });

  // ★ 内联脚本元素 (sdenv 实测: getElementsByTagName('script') 返回除最后一个
  //   外的所有元素, 且 innerText === textContent — VM 靠 innerText 找 config 块)
  const makeInlineScript = (text) => nativeifyMethods({
    nodeType: 1, nodeName: 'SCRIPT', tagName: 'SCRIPT', type: 'text/javascript',
    textContent: text,
    innerText: text,
    innerHTML: text,
    src: '',
    getAttribute(name) {
      if (name === 'r') return 'm';
      if (name === 'type') return 'text/javascript';
      return null;
    },
    hasAttribute(name) { return ['r', 'type'].includes(name); },
    setAttribute() { }, removeAttribute() { },
    attributes: {
      r: { value: 'm', name: 'r' },
      type: { value: 'text/javascript', name: 'type' },
      length: 2, item() { return null; },
    },
    parentElement: null, parentNode: null,
    childNodes: [], children: [],
    removeChild(c) { return c; },
  });
  // ★ 第 2 个 meta (content-type) — jsdom 实测 head children = [META, META, SCRIPT, SCRIPT]
  const metaEl2 = nativeifyMethods({
    nodeType: 1, nodeName: 'META', tagName: 'META',
    content: 'text/html; charset=utf-8',
    getAttribute(name) {
      if (name === 'http-equiv') return 'Content-Type';
      if (name === 'content') return 'text/html; charset=utf-8';
      return null;
    },
    hasAttribute(name) { return ['http-equiv', 'content'].includes(name); },
    attributes: { length: 2, item() { return null; } },
    getElementsByTagName() { return makeCollection([]); },
    childNodes: [], children: [],
    parentNode: null, parentElement: null,
    removeChild(c) { return c; }, insertBefore() { }, replaceChild() { },
  });
  let scriptEl = makeInlineScript(inlineScripts[0] || '');
  const scriptEl2 = makeInlineScript(inlineScripts[1] || '');
  // ★ 第 3 个 script: 外部主 VM 脚本 (jsdom scripts[2].src = 绝对 URL)
  const scriptEl3 = nativeifyMethods({
    nodeType: 1, nodeName: 'SCRIPT', tagName: 'SCRIPT', type: 'text/javascript',
    textContent: '', innerText: '', innerHTML: '',
    src: scriptSrc,
    getAttribute(name) {
      if (name === 'r') return 'm';
      if (name === 'type') return 'text/javascript';
      if (name === 'src') return scriptSrc;
      return null;
    },
    hasAttribute(name) { return ['r', 'type', 'src'].includes(name); },
    setAttribute() { }, removeAttribute() { },
    attributes: {
      r: { value: 'm', name: 'r' }, type: { value: 'text/javascript', name: 'type' },
      src: { value: scriptSrc, name: 'src' }, length: 3, item() { return null; },
    },
    parentElement: null, parentNode: null,
    childNodes: [], children: [],
    removeChild(c) { return c; },
  });
  // ★ 第 4 个 script: html 外的 _$_d(); 触发脚本 (jsdom scripts[3])
  const scriptEl4 = makeInlineScript(inlineScripts[2] || '');

  // boot 阶段树中的第二个 script 元素 (内联触发块, 无 src)
  const triggerScriptEl = nativeifyMethods({
    nodeType: 1, nodeName: 'SCRIPT', tagName: 'SCRIPT', type: 'text/javascript',
    src: '',
    getAttribute(name) { return name === 'type' ? 'text/javascript' : null; },
    hasAttribute(name) { return name === 'type'; },
    setAttribute() { }, removeAttribute() { },
    attributes: { type: { value: 'text/javascript', name: 'type' }, length: 1, item() { return null; } },
    parentElement: null, parentNode: null,
    childNodes: [], children: [],
    removeChild(c) { return c; },
  });

  const _head = nativeifyMethods({
    nodeName: 'HEAD', tagName: 'HEAD', nodeType: 1,
    getAttribute() { return null; }, hasAttribute() { return false; },
    setAttribute() { }, removeAttribute() { }, attributes: {},
    // ★ jsdom 实测: head children = [META, META, SCRIPT, SCRIPT]
    children: [metaEl, metaEl2, scriptEl, scriptEl2], childNodes: [metaEl, metaEl2, scriptEl, scriptEl2],
    appendChild(c) { if (c) { c.parentNode = _head; c.parentElement = _head; } this.children.push(c); this.childNodes.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); this.childNodes.splice(i, 1); } if (c) { c.parentNode = null; c.parentElement = null; } return c; },
    getElementsByTagName(tag) {
      const t = (tag || '').toLowerCase();
      if (t === 'meta') return makeCollection([metaEl, metaEl2]);
      if (t === 'script') return makeCollection([scriptEl, scriptEl2]);
      return makeCollection([]);
    },
    querySelectorAll() { return makeCollection([]); },
    parentNode: null, parentElement: null,
  });
  metaEl.parentNode = _head; metaEl.parentElement = _head;
  metaEl2.parentNode = _head; metaEl2.parentElement = _head;
  scriptEl.parentNode = _head; scriptEl.parentElement = _head;
  scriptEl2.parentNode = _head; scriptEl2.parentElement = _head;
  _setProto(metaEl, 'meta');
  _setProto(metaEl2, 'meta');
  _setProto(scriptEl, 'script');
  _setProto(triggerScriptEl, 'script');
  _setProto(_head, 'head');

  // ★ iframe 帧跟踪: appendChild 到文档树 → window.length+1 (jsdom 实测: VM 挂 iframe 后 length 0→1)
  const _frames = [
];
  const _registerFrame = (c) => {
    if (c && c.nodeName === 'IFRAME' && !_frames.includes(c)) _frames.push(c);
  };
  const _unregisterFrame = (c) => {
    const i = _frames.indexOf(c);
    if (i >= 0) _frames.splice(i, 1);
  };

  const _body = nativeifyMethods({
    nodeName: 'BODY', tagName: 'BODY', nodeType: 1,
    getAttribute() { return null; }, hasAttribute() { return false; },
    setAttribute() { }, removeAttribute() { }, attributes: {},
    // ★ jsdom 实测: body 元素存在 (children=[SCRIPT,SCRIPT]) 但 document.body = null
    children: [scriptEl3, scriptEl4], childNodes: [scriptEl3, scriptEl4],
    innerHTML: '', innerText: '', textContent: '',
    appendChild(c) { if (c) { c.parentNode = _body; c.parentElement = _body; _registerFrame(c); } this.children.push(c); this.childNodes.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); this.childNodes.splice(i, 1); } if (c) { c.parentNode = null; c.parentElement = null; _unregisterFrame(c); } return c; },
    getElementsByTagName(tag) {
      const t = (tag || '').toLowerCase();
      if (t === 'iframe') return makeCollection(_frames.slice());
      if (t === 'script') return makeCollection([scriptEl3, scriptEl4]);
      return makeCollection([]);
    },
    querySelectorAll() { return makeCollection([]); },
    style: {}, parentNode: null, parentElement: null,
  });
  scriptEl3.parentNode = _body; scriptEl3.parentElement = _body;
  scriptEl4.parentNode = _body; scriptEl4.parentElement = _body;
  _setProto(scriptEl3, 'script');
  _setProto(scriptEl4, 'script');

  // ================================================================
  // Document + Cookie 拦截 ★
  // ================================================================
  const _cookieStore = {};
  let _docCookie = '';

  const documentElement = nativeifyMethods({
    nodeName: 'HTML', tagName: 'HTML', nodeType: 1,
    getAttribute() { return null; }, hasAttribute() { return false; },
    setAttribute() { }, removeAttribute() { }, attributes: {},
    outerHTML: '',
    children: [_head, _body], childNodes: [_head, _body],
    parentNode: null, parentElement: null,
    style: {},
    appendChild(c) { if (c) { c.parentNode = documentElement; c.parentElement = documentElement; _registerFrame(c); } this.children.push(c); this.childNodes.push(c); return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) { this.children.splice(i, 1); this.childNodes.splice(i, 1); }
      if (c) { c.parentNode = null; c.parentElement = null; _unregisterFrame(c); }
      return c;
    },
    getElementsByTagName(tag) {
      if ((tag || '').toLowerCase() === 'iframe') return makeCollection(_frames.slice());
      return makeCollection([]);
    },
  });

  const _doc = nativeifyMethods({
    nodeType: 9, nodeName: '#document',
    head: _head,
    // ★★★ 2026-08-19 修复: jsdom 渲染 412.html 时 document.body = body 元素 (非 null)!
    //   S 侧 trace 证实: 0-215 任务 document.body=[o] → appendChild(div) 成功 →
    //   MutationObserver.observe → 0-31 检测 → 0-241 创建隐藏 iframe → 第三轮 428 键。
    //   body=null 时 appendChild 失败 → 整条检测链跳过 → 无第三轮 → cookie 400。
    body: _body,
    documentElement,
    // ★ jsdom 集合键: forms/images/embeds/plugins/links/anchors/applets = HTMLCollection
    forms: makeCollection([]), images: makeCollection([]), embeds: makeCollection([]),
    plugins: makeCollection([]), links: makeCollection([]), anchors: makeCollection([]),
    applets: makeCollection([]),
    // ★ scripts = 4 个 (jsdom 实测 len=4); styleSheets = StyleSheetList len=0
    scripts: makeCollection([scriptEl, scriptEl2, scriptEl3, scriptEl4]),
    styleSheets: (function () {
      const ss = { length: 0, item() { return null; } };
      try { Object.defineProperty(ss, Symbol.toStringTag, { value: 'StyleSheetList', configurable: true }); } catch (e) {}
      return ss;
    })(),

    // ★ Cookie 拦截: 已迁移到 _pchain.docProto (2026-08-31 jsdom 对齐:
    //   jsdom 实例无自有 cookie 键 — 访问器在 Document 原型上, for-in 不枚举)

    // DOM 查询
    getElementsByTagName(tag) {
      const t = (tag || '').toLowerCase();
      // ★ 活集合: 从当前树状态计算 (VM 的 while(len) remove 循环依赖集合收缩)
      if (t === 'meta') return makeCollection([metaEl, metaEl2].filter(m => m.parentNode));
      // ★★★ 2026-08-31 O49LEN 探针实锤: S 侧 (jsdom+sdenv补丁) 返回 Array(2) =
      //   [tsInline(scriptEl2), VM外链(scriptEl3)] — 预执行 script 被 jsdom 移除,
      //   entry script 被 sdenv slice(0,lastIdx) 排除, 返回类型是 Array (非 HTMLCollection!)
      //   N 侧原来返回 4 个 HTMLCollection → .length 4 vs 2 → 16-136 任务分叉 → 42 轮询参数 → 400
      if (t === 'script') return [scriptEl2, scriptEl3].filter(s => s.parentNode);
      if (t === 'head') return makeCollection([_head]);
      // ★ jsdom 实测: getElementsByTagName('body') = 1 (body 元素存在)
      if (t === 'body') return makeCollection([_body]);
      if (t === 'iframe') return makeCollection(_frames.slice());
      if (t === 'html') return makeCollection([documentElement]);
      if (t === '*') return makeCollection([_head, _body, metaEl, metaEl2, scriptEl, scriptEl2, scriptEl3, scriptEl4].filter(e => e.parentNode));
      return makeCollection([]);
    },
    getElementById(id) { return id === metaId && metaEl.parentNode ? metaEl : null; },
    querySelectorAll(sel) { return sel && sel.includes('meta') ? makeCollection([metaEl]) : makeCollection([]); },
    querySelector(sel) { return (sel && sel.includes('meta')) ? metaEl : null; },
    getElementsByClassName() { return makeCollection([]); },
    getElementsByName() { return makeCollection([]); },

    createElement(tag) {
      try {
      if (globalThis.__envLog) globalThis.__envLog('[CE] createElement(' + String(tag).slice(0, 20) + ')');
      const t = (tag || '').toLowerCase();
      const _attrs = {};
      let _pn = null, _pe = null;
      const el = nativeifyMethods({
        nodeName: t.toUpperCase(), tagName: t.toUpperCase(), nodeType: 1,
        children: [], childNodes: [], innerHTML: '', innerText: '',
        // ★ jsdom 形态: el.style = CSSStyleDeclaration 实例 (instanceof window.CSSStyleDeclaration 为 true)
        style: Object.create(_cssStyleProto),
        // ★ parentNode/parentElement 只读 (jsdom 同构: 直接赋值静默失败)
        get parentNode() { return _pn; },
        set parentNode(v) { /* 只读: 浏览器中赋值无效 */ },
        get parentElement() { return _pe; },
        set parentElement(v) { /* 只读 */ },
        // ★ 属性存储 + 反射 (VM 设 id/action 后读 getAttribute 校验)
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(_attrs, k) ? _attrs[k] : null; },
        setAttribute(k, v) { _attrs[String(k)] = String(v); },
        hasAttribute(k) { return Object.prototype.hasOwnProperty.call(_attrs, String(k)); },
        removeAttribute(k) { delete _attrs[String(k)]; },
        appendChild(c) { if (c) { c._pn = el; c._pe = el; } this.children.push(c); this.childNodes.push(c); return c; },
        removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); this.childNodes.splice(i, 1); } if (c) { c._pn = null; c._pe = null; } return c; },
        insertBefore(c) { if (c) { c._pn = el; c._pe = el; } this.children.push(c); this.childNodes.push(c); return c; },
        replaceChild(c, old) { this.removeChild(old); this.appendChild(c); return old; },
        getElementsByTagName() { return makeCollection([]); },
        querySelectorAll() { return makeCollection([]); }, querySelector() { return null; },
        addEventListener() { }, removeEventListener() { }, dispatchEvent() { return true; },
        getBoundingClientRect() { return { left: 0, top: 0, right: 300, bottom: 150, width: 300, height: 150, x: 0, y: 0 }; },
        ownerDocument: _doc,
      });
      if (globalThis.__envLog) globalThis.__envLog('[CE-RES] tag=' + t + ' str=' + String(el) + ' ctor=' + (el.constructor && el.constructor.name));
      _setProto(el, t);
      // ★ jsdom 实测: 元素的 own 可枚举键 = [] (成员全在原型上) — 指纹枚举会看到
      try {
        Object.keys(el).forEach((k) => {
          const d = Object.getOwnPropertyDescriptor(el, k);
          if (d && d.configurable) Object.defineProperty(el, k, { ...d, enumerable: false });
        });
      } catch (e) {}
      if (t === 'canvas') {
        const ctx2d = {
          fillStyle: '#000', strokeStyle: '#000', font: '10px sans-serif',
          lineWidth: 1, globalAlpha: 1, globalCompositeOperation: 'source-over',
          lineCap: 'butt', lineJoin: 'miter', miterLimit: 10,
          fillRect() { }, strokeRect() { }, clearRect() { }, fillText() { }, strokeText() { },
          measureText(t) { return { width: (t || '').length * 6, actualBoundingBoxAscent: 10 }; },
          beginPath() { }, closePath() { }, moveTo() { }, lineTo() { }, arc() { }, arcTo() { },
          bezierCurveTo() { }, quadraticCurveTo() { }, rect() { }, fill() { }, stroke() { }, clip() { },
          save() { }, restore() { }, scale() { }, rotate() { }, translate() { }, transform() { }, setTransform() { },
          drawImage() { },
          createLinearGradient() { return { addColorStop() { } }; },
          createRadialGradient() { return { addColorStop() { } }; },
          createPattern() { return null; },
          createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
          getImageData(x, y, w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
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
      if (t === 'video' || t === 'audio') {
        el.canPlayType = function (type) {
          return type && /mp4|webm|ogg|mpeg/.test(type) ? 'probably' : '';
        };
        el.play = function () { }; el.pause = function () { };
        el.load = function () { }; el.duration = NaN; el.currentTime = 0;
      }
      // id 反射 (set id → setAttribute('id') 同步)
      let _id = '';
      Object.defineProperty(el, 'id', {
        get() { return _attrs.id !== undefined ? _attrs.id : _id; },
        set(v) { _id = String(v); _attrs.id = String(v); },
        configurable: true,
      });
      if (t === 'input') {
        el.type = 'text'; el.value = ''; el.checked = false; el.files = null;
      }
      // action 反射 (form): 设置时解析为绝对 URL (浏览器行为); ★ 默认 = 当前页面 URL (jsdom 实测)
      if (t === 'form') {
        let _action = origin + '/';
        Object.defineProperty(el, 'action', {
          get() { return _action; },
          set(v) {
            _action = String(v);
            try { _action = new URL(String(v), origin + '/').href; } catch (e) {}
            _attrs.action = _action;
          },
          configurable: true,
        });
        // ★ jsdom 同构: submit/reset/length/elements 全在 HTMLFormElement.prototype — 实例零键
        delete el.submit; delete el.reset; delete el.length; delete el.elements;
      }
      if (t === 'img') { el.src = ''; el.complete = false; el.naturalWidth = 0; el.naturalHeight = 0; }
      if (t === 'div') { el.offsetWidth = 0; el.offsetHeight = 0; el.clientWidth = 0; el.clientHeight = 0; }
      if (t === 'a') {
        // ★ 锚点 URL 解析 (浏览器行为: 设 href 自动解析各字段)
        const _urlProps = ['protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'origin'];
        _urlProps.forEach((k) => { el[k] = ''; });
        Object.defineProperty(el, 'href', {
          get() { return el._href || ''; },
          set(v) {
            el._href = String(v);
            try {
              const u = new URL(String(v), origin + '/');
              el.protocol = u.protocol;
              el.host = u.host;
              el.hostname = u.hostname;
              el.port = u.port;
              el.pathname = u.pathname;
              el.search = u.search;
              el.hash = u.hash;
              el.origin = u.origin;
            } catch (e) { /* 非法 URL 保持空 */ }
          },
          configurable: true,
        });
        el.href = '';
      }
      nativeifyMethods(el, ['canPlayType', 'play', 'pause', 'load', 'submit', 'reset']);
      // ★ jsdom 同构: 实例 submit/reset 在原型 (HTMLFormElement.prototype) — nativeify 后删掉实例副本
      if (t === 'form') { try { delete el.submit; delete el.reset; } catch (e) {} }
      if (debug && (t === 'form' || t === 'input')) {
        return new Proxy(el, {
          get(target, prop) {
            if (typeof prop === 'string' && !prop.startsWith('_')) {
              const v = Reflect.get(target, prop);
              log(`[EL:${t}] get ${prop} → ${v === null ? 'null' : v === undefined ? 'undefined' : typeof v === 'function' ? 'fn' : String(v).slice(0, 20)}`);
              return v;
            }
            return Reflect.get(target, prop);
          },
          set(target, prop, val) {
            if (typeof prop === 'string') log(`[EL:${t}] set ${prop} = ${String(val).slice(0, 20)}`);
            return Reflect.set(target, prop, val);
          },
        });
      }
      return el;
      } catch (__ce) {
        if (globalThis.__envLog) globalThis.__envLog('[CE-EXC] ' + String(__ce && __ce.message || __ce).slice(0, 200));
        throw __ce;
      }
    },

    addEventListener(type, cb) { win.addEventListener(type, cb); },
    appendChild(c) {
      // ★ jsdom 同构 (2026-08-19): VM 的 form/div 等元素 appendChild 引用指向本实现
      //   (receiver=元素实例, this.documentElement 不存在) — jsdom 的 Node.prototype.appendChild
      //   原生语义 = 插入到 this 子节点; 降级分支模拟之, 消除 N 独有异常
      if (!this.documentElement) {
        const _info = 'receiver=' + String(this).slice(0, 60) + '|ctor=' + (this.constructor ? this.constructor.name : '?') + '|isDoc=' + (this === _doc) + '|same=' + (this.appendChild === _doc.appendChild) + '|c=' + String(c).slice(0, 40);
        try { require('fs').appendFileSync('doc_ac_log.txt', _info + String.fromCharCode(10)); } catch (e) {}
        log('[DOC-AC] ' + _info);
        if (c) { c.parentNode = this; c.parentElement = this; }
        if (Array.isArray(this.children)) { this.children.push(c); this.childNodes.push(c); }
        return c;
      }
      if (c) { c.parentNode = _doc; }
      return this.documentElement.appendChild(c);
    },
    removeChild(c) { return this.documentElement.removeChild(c); },
    replaceChild(c, old) { this.documentElement.removeChild(old); this.documentElement.appendChild(c); return old; },
    removeEventListener(type, cb) { win.removeEventListener(type, cb); },
    dispatchEvent() { return true; },
    createEvent() { return { initEvent() { } }; },
    createDocumentFragment() { return { appendChild(c) { return c; } }; },
    createTextNode() { return { nodeType: 3, textContent: '' }; },
    createComment() { return {}; },
    execCommand() { return false; }, hasChildNodes() { return true; },
    createTreeWalker() { return {}; }, createNodeIterator() { return {}; },
    importNode() { return {}; }, adoptNode() { return {}; },

    charset: 'utf-8', characterSet: 'UTF-8', readyState: 'complete',
    visibilityState: 'visible', hidden: false, hasFocus() { return true; },
    title: '', domain: host, URL: url, documentURI: url,
    // ★ document.all: 浏览器中 typeof 为 'undefined' 但值是对象 (jsdom 实测 [object Object] + length:3)
    all: (function () {
      const coll = {};
      coll.length = 3;
      Object.defineProperty(coll, Symbol.toPrimitive, { value: () => '' });
      return coll;
    })(),
  });
  // ★ 完整父链 (jsdom: body.parentNode=html, html.parentNode=document)
  _head.parentNode = documentElement;
  _body.parentNode = documentElement;
  documentElement.parentNode = _doc;
  _setProto(_body, 'body');
  _setProto(documentElement, 'html');
  // ★★★ 2026-08-31 jsdom 对齐: cookie 访问器在 Document 原型 (实例无自有键, for-in 不枚举);
  //   referrer = 实例自有数据属性 e:false (jsdom 加载 412.html 实测 PROBE-AFTER: refDesc={e:false,w:false,g:false})
  try {
    Object.defineProperty(_pchain.docProto, 'cookie', {
      get: function () { return _docCookie; },
      set: function (value) {
        // ★ 2026-09-01 根因修复: VM 侧 --fixdate 固定时间 (1786867200000=2026-08-23), 宿主侧 Date.now 是真实时间
        //   (2026-09+) → expires(8-23) 被判过期删除 → 主 cookie 写完即删 → RESULT 0c!
        //   判断基准对齐 VM 时间源 (jsdom 侧 beforeParse fixdate 同理)
        const __nowBase = fixDateMs || Date.now();
        const parts = String(value).split(';');
        const main = parts[0].trim();
        const eq = main.indexOf('=');
        if (eq > 0) {
          const key = main.substring(0, eq).trim();
          const val = main.substring(eq + 1).trim();
          let del = false;
          for (const attr of parts.slice(1)) {
            const a = attr.trim().toLowerCase();
            if (a.startsWith('max-age=')) {
              if (parseFloat(a.slice(8)) <= 0) del = true;
            } else if (a.startsWith('expires=')) {
              const t = Date.parse(attr.trim().slice(8));
              if (!isNaN(t) && t < __nowBase) del = true;
            }
          }
          if (del || val === '') {
            delete _cookieStore[key];
            log(`[COOKIE-DEL] ${key}`);
          } else {
            _cookieStore[key] = val;
            log(`[COOKIE] ${key}=${val.substring(0, 40)}... (${_docCookie.length} chars)`);
            // ★ 2026-08-31: 无条件文件日志 (debug 模式的 log 是空函数, 无法验证 setter 调用)
            try {
              require('fs').appendFileSync('cookie_writes.log',
                Date.now() + ' ' + key + '=' + val.substring(0, 50) + '\n', 'utf-8');
            } catch (e) {}
            if (key.endsWith('P') && globalThis.__envLog) {
              globalThis.__envLog('[COOKIE-STACK] ' + String(new Error().stack).split(String.fromCharCode(10)).slice(1, 6).join(' < '));
              try {
                if (win.__taskLog && win.__taskLog.length < 5000) {
                  var __last = null;
                  for (var __mi = win.__taskLog.length - 1; __mi >= 0; __mi--) {
                    if (win.__taskLog[__mi].start !== undefined) { __last = __mi; break; }
                  }
                  var __argdump = null;
                  if (__last !== null && win.__taskLog[__last].__args) {
                    __argdump = win.__taskLog[__last].__args;
                  }
                  win.__taskLog.push({ cookieWrite: 1, valHead: val.substring(0, 16), lastEntry: __last, argDump: __argdump });
                }
              } catch (e) {}
            }
          }
          _docCookie = Object.entries(_cookieStore).map(([k, v]) => k + '=' + v).join('; ');
        }
      },
      enumerable: false, configurable: true,
    });
    Object.defineProperty(_doc, 'referrer', { value: '', writable: false, enumerable: false, configurable: true });
  } catch (e) { log('[DOCALIGN] err: ' + e.message); }
  try { Object.setPrototypeOf(_doc, _pchain.docProto); } catch (e) {}
  setGlobalRO('document', _doc);

  // ★ debug: removeChild 调用日志 (定位 null.removeChild 崩溃点)
  if (debug) {
    const wrapRc = (el, name) => {
      const orig = el.removeChild;
      el.removeChild = function (c) {
        log(`[RC] ${name}.removeChild(${c ? c.tagName || c.nodeName : '?'})`);
        return orig.call(this, c);
      };
    };
    wrapRc(scriptEl, 'scriptEl');
    wrapRc(scriptEl2, 'scriptEl2');
    wrapRc(_head, 'head');
    wrapRc(_body, 'body');
    wrapRc(documentElement, 'html');
    wrapRc(_doc, 'document');
  }
  // ★ debug: 用 Proxy 包装 DOM 元素, 记录 null 读取
  if (debug) {
    const _spyEl = (el, name) => new Proxy(el, {
      get(target, prop) {
        if (typeof prop === 'string' && !prop.startsWith('_') && prop !== 'then') {
          const v = Reflect.get(target, prop);
          if (v === null || v === undefined) {
            log(`[EL:${name}] get ${prop} → ${v === null ? 'NULL' : 'undefined'}`);
          } else {
            log(`[EL:${name}] get ${prop} → ${typeof v === 'function' ? 'fn' : String(v).slice(0, 30)}`);
          }
          return v;
        }
        return Reflect.get(target, prop);
      },
    });
    metaEl = _spyEl(metaEl, 'meta');
    scriptEl = _spyEl(scriptEl, 'script');
    _head.children[0] = metaEl; _head.childNodes[0] = metaEl;
    _head.children[1] = scriptEl; _head.childNodes[1] = scriptEl;
    documentElement.__spied = true;
    _doc.getElementById = function (id) {
      const r = id === metaId ? metaEl : null;
      log(`[DOM] getElementById(${id}) → ${r ? 'meta' : 'null'}`);
      return r;
    };
    _doc.getElementsByTagName = function (tag) {
      const t = (tag || '').toLowerCase();
      const r = t === 'meta' ? makeCollection([metaEl]) : (t === 'script' ? makeCollection([scriptEl, scriptEl2]) : makeCollection([]));
      log(`[DOM] getElementsByTagName(${t}) → [${r.length}]`);
      return r;
    };
    _doc.querySelector = function (sel) {
      const r = sel && sel.includes('meta') ? metaEl : null;
      log(`[DOM] querySelector(${String(sel).slice(0, 40)}) → ${r ? 'meta' : 'null'}`);
      return r;
    };
  }

  // ================================================================
  // Storage
  // ================================================================
  const _ls = {}, _ss = {};
  setGlobal('localStorage', withTag({
    getItem(k) { return _ls.hasOwnProperty(k) ? _ls[k] : null; },
    setItem(k, v) { _ls[k] = String(v); }, removeItem(k) { delete _ls[k]; },
    clear() { for (const k in _ls) delete _ls[k]; },
    key(i) { return Object.keys(_ls)[i] || null; },
    get length() { return Object.keys(_ls).length; },
  }, 'Storage'));
  setGlobal('sessionStorage', withTag({
    getItem(k) { return _ss.hasOwnProperty(k) ? _ss[k] : null; },
    setItem(k, v) { _ss[k] = String(v); }, removeItem(k) { delete _ss[k]; },
    clear() { for (const k in _ss) delete _ss[k]; },
    key(i) { return Object.keys(_ss)[i] || null; },
    get length() { return Object.keys(_ss).length; },
  }, 'Storage'));

  // ================================================================
  // Network (空 XHR — 挑战页不出网)
  // ================================================================
  const XHR = makeNative('XMLHttpRequest', 'class XMLHttpRequest extends EventTarget { [native code] }');
  XHR.prototype.constructor = XHR;
  const _XHRWrap = function XMLHttpRequest() { };
  NATIVE_FNS.add(_XHRWrap); // fakePTS 查表 (name='XMLHttpRequest' → jsdom class 源码)
  Object.setPrototypeOf(_XHRWrap, XHR);
  Object.setPrototypeOf(_XHRWrap.prototype, XHR.prototype);
  // ★★★ 2026-08-19 重构 (task 1564/899 等): XHR.prototype 对齐 jsdom (xhr_proto.json 实测)
  //   键序 = jsdom: constructor,open,setRequestHeader,send,abort,getResponseHeader,
  //   getAllResponseHeaders,overrideMimeType,onreadystatechange,readyState,timeout,
  //   withCredentials,upload,responseURL,status,statusText,responseType,response,
  //   responseText,responseXML,UNSENT,OPENED,HEADERS_RECEIVED,LOADING,DONE
  //   - 方法 toString = jsdom 源码 (xhr_fn_* 查表 via __srcText)
  //   - getter/setter toString = jsdom 源码 (xhr_get_*/xhr_set_* via __getterName)
  //   - 常量也是 prototype getters (jsdom 实测!) — 之前只有 5 常量 getters → 键序分叉
  {
    const _xhrProtoData = require('./xhr_proto.json');
    // upload 值: jsdom 实例形态 ([object XMLHttpRequestUpload], own keys=0, proto 仅 constructor)
    const _xhrUploadProto = Object.create(null);
    Object.defineProperty(_xhrUploadProto, Symbol.toStringTag, { value: 'XMLHttpRequestUpload', configurable: true });
    const _xhrUpload = Object.create(_xhrUploadProto);
    Object.defineProperty(_xhrUploadProto, 'constructor', {
      value: (function XMLHttpRequestUpload() {}), configurable: true,
    });
    XHR.prototype = {};
    for (const k of _xhrProtoData.order) {
      const d = _xhrProtoData.descs[k];
      const def = { configurable: true, enumerable: d.enum };
      if (d.getter) {
        def.get = function () {
          switch (k) {
            case 'readyState': return 0;
            case 'timeout': return 0;
            case 'withCredentials': return false;
            case 'upload': return _xhrUpload;
            case 'responseURL': return '';
            case 'status': return 0;
            case 'statusText': return '';
            case 'responseType': return '';
            case 'response': return null;
            case 'responseText': return '';
            case 'responseXML': return null;
            case 'onreadystatechange': return null;
            case 'UNSENT': return 0; case 'OPENED': return 1;
            case 'HEADERS_RECEIVED': return 2; case 'LOADING': return 3; case 'DONE': return 4;
            default: return undefined;
          }
        };
        // getter 函数 (V8 name='get') — __getterName 让 fakePTS 查表返回 jsdom getter 源码
        try { Object.defineProperty(def.get, '__getterName', { value: 'xhr_get_' + k, configurable: true }); } catch (e4) {}
        NATIVE_FNS.add(def.get);
      }
      if (d.setter) {
        def.set = function () {};
        try { Object.defineProperty(def.set, '__getterName', { value: 'xhr_set_' + k, configurable: true }); } catch (e4) {}
        NATIVE_FNS.add(def.set);
      }
      if (d.fn && k !== 'constructor') {
        const m = function () {};
        // __srcText = jsdom 方法源码 (VM 调用时与 jsdom 一致抛 TypeError — 非 jsdom 实例)
        Object.defineProperty(m, '__srcText', { value: d.fn, configurable: true });
        def.value = m;
        def.writable = d.writable;
      }
      if (k === 'constructor') def.value = XHR;
      Object.defineProperty(XHR.prototype, k, def);
    }
    try { Object.defineProperty(XHR.prototype, Symbol.toStringTag, { value: 'XMLHttpRequest', configurable: true }); } catch (e3) {}
    // _XHRWrap 的 prototype 关联要指向新 prototype (原 1042 行指向旧对象已丢弃)
    Object.setPrototypeOf(_XHRWrap.prototype, XHR.prototype);
  }
  XHR.UNSENT = 0; XHR.OPENED = 1; XHR.HEADERS_RECEIVED = 2;
  XHR.LOADING = 3; XHR.DONE = 4;
  // ★ XHR 方法 toString: jsdom WebIDL 源码形态 (LF) — VM 读 toString 分叉修复
  //   open 与 window.open 键冲突 (JS_TEXT['open']=window.open native) → 单独源码文件
  {
    const xhrSrc = {
      open: require('fs').readFileSync(require('path').join(__dirname, 'xhr_open_src.txt'), 'utf8'),
    };
    for (const k of ['send', 'setRequestHeader', 'getResponseHeader', 'getAllResponseHeaders', 'abort', 'overrideMimeType']) {
      if (JS_TEXT[k]) xhrSrc[k] = JS_TEXT[k].text;
    }
    for (const [k, v] of Object.entries(xhrSrc)) {
      try { Object.defineProperty(XHR.prototype[k], '__srcText', { value: v, configurable: true }); } catch (e4) {}
    }
  }
  setGlobal('XMLHttpRequest', XHR);
  // ★ XPath 构造器 — sdenv/jsdom 实测: XPathEvaluator/XPathExpression/XPathResult = function,
  //   XPathException = undefined (sdenv 刻意删除) → 只补前 3 个, 不能加 XPathException (VM 会走函数分支)
  //   ★ length: XPathExpression/XPathResult = 3 (jsdom 生成代码 3 参数), XPathEvaluator = 0
  for (const n of ['XPathEvaluator', 'XPathExpression', 'XPathResult']) {
    try {
      const ctor = makeNative(n, 'function ' + n + '() { [native code] }');
      if (n !== 'XPathEvaluator') {
        try { Object.defineProperty(ctor, 'length', { value: 3, configurable: true }); } catch (e2) {}
      }
      setGlobal(n, ctor);
    } catch (e) {}
  }
  // ★ 真实 fetch: VM 会用它加载下一阶段动态脚本 (sdenv 内部 HTTP 栈同构)
  const _cookieJar = {};
  const _httpGet = (target) => {
    const mod = target.startsWith('https') ? require('https') : require('http');
    return new Promise((resolve, reject) => {
      const u = new URL(target);
      const cookieStr = Object.entries(_cookieJar).map(([k, v]) => k + '=' + v).join('; ');
      const req = mod.request({
        hostname: u.hostname, port: u.port || (target.startsWith('https') ? 443 : 80),
        path: u.pathname + u.search, method: 'GET',
        headers: { 'User-Agent': ua, 'Referer': url, Cookie: cookieStr },
      }, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => {
          for (const sc of (res.headers['set-cookie'] || [])) {
            const kv = sc.split(';')[0];
            const eq = kv.indexOf('=');
            if (eq > 0) _cookieJar[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
          }
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      });
      req.on('error', reject);
      req.end();
    });
  };
  const _realFetch = function fetch(input) {
    const target = String(input);
    log(`[FETCH] ${target.slice(0, 120)}`);
    if (!/^https?:\/\//.test(target)) return Promise.resolve({ ok: false, status: 0 });
    // ★ 同轮注入: 本地缓存脚本 (sdenv 同轮抓取) 优先返回, 排除轮次差异
    try {
      if (/\.js($|\?)/.test(target)) {
        const cached = process.env.VM_CHUNK_FILE;
        if (cached && fs.existsSync(cached)) {
          const body = fs.readFileSync(cached, 'utf-8');
          log(`[FETCH-INJECT] ${target.slice(-40)} ← ${cached} (${body.length}b)`);
          return Promise.resolve({ ok: true, status: 200,
            headers: new Map([['content-type', ['application/javascript']]]),
            text: () => Promise.resolve(body), json: () => Promise.reject(new Error('not json')) });
        }
      }
    } catch (injErr) { log('[FETCH-INJECT] err: ' + injErr.message); }
    return _httpGet(target).then(({ status, headers, body }) => ({
      ok: status === 200,
      status,
      headers: new Map(Object.entries(headers)),
      text: () => Promise.resolve(body),
      json: () => Promise.resolve(JSON.parse(body)),
    }));
  };
  Object.defineProperty(_realFetch, 'name', { value: 'fetch', configurable: true });
  Object.defineProperty(_realFetch, 'toString', { value: () => 'function fetch() { [native code] }' });
  setGlobal('fetch', _realFetch);
  // cookie jar 与 document.cookie 互通
  _doc._syncJar = (jar) => Object.assign(jar, _cookieStore);
  _realFetch._jar = _cookieJar;

  // ================================================================
  // Timers — try/catch 包裹, 缺失 API 不中断 cookie 链
  // ================================================================
  const st = setTimeout, si = setInterval, _st = st, _si = si, _ct = clearTimeout, _ci = clearInterval;
  // 源码形态与 sd_trace_fix.js beforeParse 逐字对齐 (CRLF + 6/8 空格缩进):
  //   String(setTimeout) 必须 === 'function (fn, d) {\r\n        return st(...);\r\n      }'
  setGlobal('setTimeout', function (fn, d) {
        return st(function () { try { fn(); } catch (e) {} }, d || 0);
      });
  setGlobal('setInterval', function (fn, d) {
        return si(function () { try { fn(); } catch (e) {} }, d || 0);
      });
  // ★ name 推断修正 (2026-08-19): 匿名函数赋值不推断 name → S 侧 sd_trace.js wrapper 的
  //   setTimeout.name === '' (实测). 之前错误假设赋值推断 name='setTimeout' 手动设置 →
  //   N 侧 name 有值 S 侧为空 → task 1352/1355 [f].name 读取分叉. 删掉手动 name → 对齐 S 侧 ''
  setGlobal('clearTimeout', _ct);
  setGlobal('clearInterval', _ci);

  // ================================================================
  // 其他 API
  // ================================================================
  setGlobal('performance', withTag({
    now() { return Date.now(); },
    timing: {
      navigationStart: Date.now() - 2000, loadEventEnd: Date.now() - 1000,
      domComplete: Date.now() - 500, domainLookupEnd: Date.now() - 1500,
      connectEnd: Date.now() - 1200, responseEnd: Date.now() - 800,
    },
    navigation: { type: 0, redirectCount: 0 },
    getEntries() { return []; }, getEntriesByType() { return []; }, getEntriesByName() { return []; },
    mark() { }, measure() { }, clearMarks() { }, clearMeasures() { },
    memory: { jsHeapSizeLimit: 4294967296, totalJSHeapSize: 10000000, usedJSHeapSize: 8000000 },
  }, 'Performance'));

  if (opts.crypto || globalThis.crypto) {
    const _c = opts.crypto || globalThis.crypto;
    // ★★★ 2026-08-19 修复 (task 875): host crypto.randomUUID 无标记 → fakePTS origPTS native 文本
    //   vs jsdom 源码形态 — __natName + NATIVE_FNS → 查表 JS_TEXT['randomUUID'] (309c jsdom 源码)
    if (_c && typeof _c.randomUUID === 'function') {
      try { Object.defineProperty(_c.randomUUID, '__natName', { value: 'randomUUID', configurable: true }); } catch (e2) {}
      NATIVE_FNS.add(_c.randomUUID);
    }
    setGlobal('crypto', _c);
  } else {
    const _grv = function getRandomValues(arr) { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; };
    NATIVE_FNS.add(_grv); // fakePTS 查表 (name='getRandomValues' → jsdom 原生文本)
    const _ruid = function randomUUID() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); }); };
    NATIVE_FNS.add(_ruid);
    setGlobal('crypto', { getRandomValues: _grv, subtle: undefined, randomUUID: _ruid });
  }

  const MO = makeNative('MutationObserver', 'class MutationObserver { [native code] }');
  MO.prototype = {
    observe() { }, disconnect() { }, takeRecords() { return []; },
  };
  MO.prototype.constructor = MO;
  setGlobal('MutationObserver', MO);

  const DP = function () { };
  DP.prototype = {
    parseFromString(str, type) {
      return { documentElement, querySelector() { return null; }, getElementsByTagName() { return []; } };
    },
  };
  setGlobal('DOMParser', DP);

  const _ImageFn = makeNative('Image');
  _ImageFn.prototype.constructor = _ImageFn;
  setGlobal('Image', _ImageFn);
  setGlobal('HTMLImageElement', function () { });

  const _EventFn = makeNative('Event');
  _EventFn.prototype.constructor = _EventFn;
  setGlobal('Event', _EventFn);
  setGlobal('CustomEvent', makeNative('CustomEvent'));
  for (const k of ['MouseEvent', 'KeyboardEvent', 'UIEvent', 'FocusEvent', 'InputEvent',
    'TouchEvent', 'WheelEvent', 'PointerEvent', 'ErrorEvent', 'MessageEvent',
    'PopStateEvent', 'HashChangeEvent', 'ProgressEvent']) {
    setGlobal(k, makeNative(k));
  }

  const hasNativeBlob = !!globalThis.Blob && win === globalThis;
  setGlobal('Blob', (win === globalThis && globalThis.Blob) || function (parts, opts) { this.size = 0; this.type = (opts && opts.type) || ''; });
  setGlobal('File', (win === globalThis && globalThis.File) || function () { });
  setGlobal('FileReader', (win === globalThis && globalThis.FileReader) || function () { });
  setGlobal('FileList', function () { });
  setGlobal('FormData', (win === globalThis && globalThis.FormData) || function () { this.append = function () { }; });
  // ★★★ 2026-08-19 修复 (task 1605): (win === globalThis && ...) 恒 false (win=Proxy) →
  //   URL 落对象兜底 N=[o] vs jsdom S=class URL。直接用 Node URL 类 (能真解析),
  //   fakePTS 查表 JS_TEXT['URL'] 返回 jsdom 源码形态 ✓
  setGlobal('URL', globalThis.URL);
  if (!hasNativeBlob) {
    win.Blob.prototype = { slice() { return new win.Blob(); }, get size() { return 0; }, get type() { return ''; } };
  }

  const _atobFn = function atob(s) { return Buffer.from(String(s), 'base64').toString('binary'); };
  const _btoaFn = function btoa(s) { return Buffer.from(String(s), 'binary').toString('base64'); };
  setGlobal('atob', _atobFn);
  setGlobal('btoa', _btoaFn);
  setGlobal('eval', eval);

  // ★★★ 2026-08-31: matchMedia 返回 MediaQueryList 形态 (jsdom 实测: for-in=matches,media,onchange;
  //   matches=false, onchange=null) — 空 stub 返回 undefined → 0-105 任务 .matches 读取中断 → 分叉
  const _matchMediaFn = makeNative('matchMedia');
  const _mqlStore = [];
  Object.defineProperty(_matchMediaFn, 'body', { value: null, configurable: true });
  const _matchMediaWrap = function matchMedia(q) {
    if (debug) log('[MQL] called with ' + String(q).slice(0, 40));
    const mql = {
      matches: false,
      media: String(q),
      onchange: null,
    };
    try { Object.defineProperty(mql, Symbol.toStringTag, { value: 'MediaQueryList', configurable: true }); } catch (e) {}
    _mqlStore.push(mql);
    return mql;
  };
  NATIVE_FNS.add(_matchMediaWrap);
  Object.defineProperty(_matchMediaWrap, 'name', { value: 'matchMedia', configurable: true });
  try { Object.defineProperty(_matchMediaWrap, 'length', { value: 1, configurable: true }); } catch (e) {}
  setGlobal('matchMedia', _matchMediaWrap);
  setGlobal('getComputedStyle', makeNative('getComputedStyle'));
  // ★★★ 2026-08-19 修复 (task 1361/1364): 删掉 own toString 赋值!
  //   之前 win.requestAnimationFrame.toString = _rafFn.toString 装了 own origPTS →
  //   VM 直接调 fn.toString() 绕过 fakePTS → 返回真实源码 'function (cb) {...}' (匿名)
  //   jsdom 的 rAF/cAF 无 own toString → String(fn) 走原型 → 沙箱 fakePTS
  //   → __natName='requestAnimationFrame' → JS_TEXT 查表 → 'function requestAnimationFrame() { [native code] }' ✓
  setGlobal('requestAnimationFrame', function (cb) { return _st(cb, 16); });
  setGlobal('cancelAnimationFrame', function (id) { _ct(id); });

  // ★ open/prompt/alert: jsdom WebIDL 特殊函数 — 读取 prototype = undefined
  //   (prompt/open own 键值 undefined; alert 无键) — bound 函数 prototype 读值 undefined ✓
  //   toString = 'function () { [native code] }' 含 [native code] ✓ (VM indexOf 检测通过)
  //   ★ 普通 JS 函数 prototype=对象 → VM 检查 prompt.prototype 分叉 (Task 874)!
  const _openFn = (function () { return null; }).bind(null);
  Object.defineProperty(_openFn, 'name', { value: 'open', configurable: true });
  setGlobal('open', _openFn);
  setGlobal('close', function () { });
  const _alertFn = function () { }.bind(null);
  Object.defineProperty(_alertFn, 'name', { value: 'alert', configurable: true });
  setGlobal('alert', _alertFn);
  setGlobal('confirm', function () { return true; });
  const _promptFn = (function () { return null; }).bind(null);
  Object.defineProperty(_promptFn, 'name', { value: 'prompt', configurable: true });
  setGlobal('prompt', _promptFn);
  setGlobal('print', function () { });
  setGlobal('postMessage', function () { });
  setGlobal('scrollTo', function () { });
  setGlobal('scrollBy', function () { });
  // ★★ jsdom Window IDL 方法批量对齐 (2026-08-19):
  //   VM chunk 运行期写入 window.moveBy 等 (N 侧未预定义 → 可写 → 写入 length=0 函数)
  //   jsdom 这些是只读 IDL → 赋值失败 → S 侧保持 jsdom 原生 (精确 length)
  //   Task 1407 分叉: moveBy.length N=0 vs S=2 → name 检查分支分叉!
  //   jsdom 实测 length (sdenv trace 逐任务核对): moveBy=2 moveTo=2 resizeBy=2 resizeTo=2
  //   webkitRequestFileSystem=3 webkitResolveLocalFileSystemURL=2
  //   requestAnimationFrame/cancelAnimationFrame/queueMicrotask/cancelIdleCallback/
  //   createImageBitmap/requestIdleCallback/structuredClone/webkitRequestAnimationFrame/
  //   webkitCancelAnimationFrame/reportError/postMessage/Worker/matchMedia/getComputedStyle=1
  //   scrollTo/scrollBy/scroll/focus/blur/stop/close/print/find/getSelection/
  //   captureEvents/releaseEvents/getScreenDetails/queryLocalFonts/
  //   showDirectoryPicker/showOpenFilePicker/showSaveFilePicker=0
  {
    const _webidlMethods = {
      moveBy: 2, moveTo: 2, resizeBy: 2, resizeTo: 2,
      webkitRequestFileSystem: 3, webkitResolveLocalFileSystemURL: 2,
      webkitRequestAnimationFrame: 1, webkitCancelAnimationFrame: 1,
      scrollTo: 0, scrollBy: 0, scroll: 0,
      focus: 0, blur: 0, stop: 0, close: 0, print: 0, find: 0,
      reportError: 1, getSelection: 0, captureEvents: 0, releaseEvents: 0,
      postMessage: 1, queueMicrotask: 1,
      cancelIdleCallback: 1, createImageBitmap: 1, requestIdleCallback: 1,
      structuredClone: 1, getScreenDetails: 0, queryLocalFonts: 0,
      showDirectoryPicker: 0, showOpenFilePicker: 0, showSaveFilePicker: 0,
      getComputedStyle: 1,
      // ★ matchMedia 已由上方 _matchMediaWrap 提供 (返回 MediaQueryList) — 勿在此覆盖
    };
    for (const [k, len] of Object.entries(_webidlMethods)) {
      const f = makeNative(k);
      try { Object.defineProperty(f, 'length', { value: len, configurable: true }); } catch (e2) {}
      setGlobal(k, f);
    }
  }
  // ★ clearTimeout/clearInterval: jsdom length=0 (可选参数) — Node 原生 length=1
  //   wrap 保留真实清除功能 (VM 依赖) + length 归 0
  for (const [k, orig] of [['clearTimeout', _ct], ['clearInterval', _ci]]) {
    const w = function () { return orig.apply(null, arguments); };
    Object.defineProperty(w, 'name', { value: k, configurable: true });
    setGlobal(k, w);
  }
  // ★ Worker: jsdom length=1 (scriptURL 必选)
  {
    const _workerFn = makeNative('Worker');
    try { Object.defineProperty(_workerFn, 'length', { value: 1, configurable: true }); } catch (e2) {}
    setGlobal('Worker', _workerFn);
  }
  // ★ addEventListener: 存储监听器; 'load' 回调等待 time-0 timer 链完成 (sdenv 同款, 瑞数依赖)
  const _listeners = {};
  // ★★ 决定性: own addEventListener 必须存在 + enumerable:true! ★★
  //   sdenv-jsdom: window 的 own addEventListener enum=true (generated/Window.js 实测)
  //   VM 的 B=30 收集器在 window realm 里 for-in (慢路径):
  //     - own 键 enum=false → 不输出 + 遮蔽原型同名键 → 0 次/遍 (之前 400 分叉点!)
  //     - own 键 enum=true  → 每遍输出 1 次 → 环绕 2 遍 = 2 次 (与 sdenv S=2 对齐!)
  //   VM 还依赖 own 键存在 (05:24 实测: 删 own 键 → VM 提前终止, cookie 只有 319 chars)
  //   原型键 (下面原型块) 保留 — 被 own 遮蔽, 无害
  const _addEventListener = function (type, cb) {
    if (!_listeners[type]) _listeners[type] = [];
    const wrapped = function (...params) {
      if (type === 'load') {
        // sdenv: 等待所有未执行的 time-0 timer 完成 (最多 5 个 tick)
        const delayTick = () => new Promise((r) => _st(r, 0));
        return (async () => {
          let mintime = 5;
          do {
            await delayTick();
          } while (mintime-- > 0);
          try { cb(...params); } catch (e) {
            log('[LOAD-CB-ERR] ' + e.message + ' | ' + (e.stack || '').split('\n')[1]);
          }
        })();
      }
      cb(...params);
    };
    _listeners[type].push(wrapped);
  };
  // ★★★ 2026-08-19 修复 (task 1496): __natName + NATIVE_FNS — 直接 defineProperty 不走 setGlobal,
  //   无标记 → fakePTS origPTS 返回匿名源码 vs jsdom 'function addEventListener() { [native code] }'
  try { Object.defineProperty(_addEventListener, '__natName', { value: 'addEventListener', configurable: true }); } catch (e2) {}
  // ★★★ 2026-08-19 修复 (task 1496 name): 推断名 '_addEventListener' vs jsdom 'addEventListener'
  //   fn.name 直接进指纹数组 (B=30 收集器) → 分叉
  try { Object.defineProperty(_addEventListener, 'name', { value: 'addEventListener', configurable: true }); } catch (e2) {}
  NATIVE_FNS.add(_addEventListener);
  Object.defineProperty(win, 'addEventListener', {
    value: _addEventListener, writable: true, configurable: true, enumerable: true,
  });
  // ★ 2026-08-19 修复 (ARG30 双条件):
  //   1) 不预定义 win own removeEventListener/dispatchEvent — jsdom 空页实测无 own 键,
  //      VM 运行期会自己创建 (own, enum:true, 插入序尾部) → for-in window = 229 ✓
  //      (预定义 → VM 检测已存在跳过创建 → align 降 enum:false → 227 分叉, 已踩坑!)
  //   2) 链上 (下块) 的 2 键保持 enum:false — jsdom for-in getPrototypeOf(window)=0 (断链) ✓
  // ★ 参照系 = sdenv-jsdom 2.1.0 实测 (probe_proto.js 2026-08-19):
  //   链: window → Window.prototype (own 无事件键, for-in=0) → EventTarget级1 → EventTarget级2 (3 键 enum:true)
  //   ★★ for-in Window.prototype = 0 但 for-in 更深处 = 3 键 → jsdom 内部结构在 Window.prototype 级"断链"
  //      (标准原型链无法模拟断链, 等效方案: 3 键 enum:false → 对一切 for-in 不可见, 与断链效果一致)
  //   ★★ 修复动机 (2026-08-19 ARG30 探针实测): 原挂 _evProto 且 enum:true →
  //      for-in winProto 出 3 键 (N) vs jsdom 0 键 (S) → 环境指纹分叉 → 400
  //   行为兼容: getOwnPropertyNames(_evProto) 仍含 3 键 (enum 不影响 ownNames); 取值行为不变
  //   B=30 for-in window: jsdom 只出 own addEventListener (enum:true, 1 次/遍) — 1217 行 own 键已满足
  try {
    const _winProto = Object.getPrototypeOf(win);
    const _evProto = Object.getPrototypeOf(_winProto);
    if (_evProto) {
      // ★★★ 2026-08-19 修复 (task 1559/1562): 同 addEventListener — 匿名 vs jsdom 命名
      //   JS_TEXT['removeEventListener']/['dispatchEvent'] = jsdom 源码 → fakePTS 查表返回原文
      const _removeEventListenerFn = function (type, cb) {
        if (_listeners[type]) _listeners[type] = _listeners[type].filter((f) => f !== cb);
      };
      try { Object.defineProperty(_removeEventListenerFn, '__natName', { value: 'removeEventListener', configurable: true }); } catch (e2) {}
      NATIVE_FNS.add(_removeEventListenerFn);
      Object.defineProperty(_evProto, 'removeEventListener', {
        value: _removeEventListenerFn, writable: true, configurable: true, enumerable: false,
      });
      const _dispatchEventFn = function (ev) {
        const type = ev && (ev.type !== undefined ? ev.type : String(ev));
        if (type && _listeners[type]) {
          for (const f of _listeners[type].slice()) {
            try { f(ev); } catch (e) { log('[EV-ERR] ' + e.message); }
          }
        }
        return true;
      };
      try { Object.defineProperty(_dispatchEventFn, '__natName', { value: 'dispatchEvent', configurable: true }); } catch (e2) {}
      NATIVE_FNS.add(_dispatchEventFn);
      Object.defineProperty(_evProto, 'dispatchEvent', {
        value: _dispatchEventFn, writable: true, configurable: true, enumerable: false,
      });
      // addEventListener 的实现也放原型 (jsdom: window 无 own 键, 链上 for-in 不可见)
      Object.defineProperty(_evProto, 'addEventListener', {
        value: _addEventListener, writable: true, configurable: true, enumerable: false,
      });
    }
  } catch (e) {}
  win.dispatchLoad = function () {
    for (const f of (_listeners.load || [])) {
      // ★ 异常隔离: VM 的探针 (如 parentNode 只读检测) 靠抛异常探测浏览器行为,
      //   sdenv 的 timer try/catch 会吞掉 — 这里同步调用必须同样隔离
      try { f({ type: 'load' }); } catch (e) { log('[LOAD-ERR] ' + e.message); }
    }
  };
  setGlobal('attachEvent', function () { return true; });
  setGlobal('detachEvent', function () { });

  win.innerWidth = 1024; win.innerHeight = 768;
  win.outerWidth = 1024; win.outerHeight = 768;
  win.screenX = 0; win.screenY = 0; win.screenLeft = 0; win.screenTop = 0;
  win.devicePixelRatio = 1;
  win.scrollX = 0; win.scrollY = 0; win.pageXOffset = 0; win.pageYOffset = 0;
  // ★ window.length = 帧数 (VM 挂 iframe 后 jsdom 实测 0→1; jsdom 可枚举)
  try {
    Object.defineProperty(win, 'length', {
      get() { return _frames.length; },
      configurable: true, enumerable: true,
    });
  } catch (e) { win.length = 0; }
  win.frameElement = null; win.name = '';
  // ★ window.chrome: jsdom 实测为空对象 {} (不要带 loadTimes/csi/app — 形状会进指纹)
  setGlobal('chrome', {});
  setGlobal('external', {});
  // ★ window.chrome: sdenv mock (Task 1577/1564 分叉: chrome.csi N='function () {}' vs S='function() {}')
  //   ★★★ 2026-08-19 修复: sdenv/browser/chrome/chrome.js 源码是 'function() {}' (无空格) —
  //   V8 toString 保留源码 → 逐字符对齐 (csi/loadTimes 是子属性, 无 fakePTS 标记 → 读源码!)
  setGlobal('chrome', withTag({ csi: function() {}, loadTimes: function() {} }, 'Chrome'));
  // ★★★ 2026-08-19 修复 (task 875): win === globalThis 恒 false → Intl 恒 {} —
  //   supportedValuesOf 等缺失 → VM indexOf.call(undefined) 分叉; host Intl 完整
  setGlobal('Intl', globalThis.Intl);

  // 与 sdenv/jsdom 实测对齐:
  // ★ 存在的 API (native 形态)
  setGlobal('RTCPeerConnection', makeNative('RTCPeerConnection'));
  setGlobal('webkitRTCPeerConnection', makeNative('webkitRTCPeerConnection'));
  // ★ Worker 已在 IDL 批量块定义 (length=1 对齐 jsdom) — 此处不再覆盖
  setGlobal('WebSocket', makeNative('WebSocket', 'class WebSocket extends EventTarget { [native code] }'));
  setGlobal('indexedDB', withTag({ open() { return {}; } }, 'IDBFactory'));
  setGlobal('webkitIndexedDB', { open() { return {}; } });
  // 真正 undefined 的 API
  for (const k of ['AudioContext', 'webkitAudioContext', 'OfflineAudioContext',
    'SharedWorker', 'ServiceWorker', 'BroadcastChannel', 'Notification', 'Permissions',
    'Geolocation', 'EventSource']) {
    setGlobal(k, undefined);
  }

  // ================================================================
  // $_ts 入口 (瑞数)
  // ================================================================
  // ★ 只设 nsd/cd — 挑战页 config 块只设这两个; scj/aebi 必须 undefined
  //   (VM 代码生成器 IIFE 接收 ($_ts.scj, $_ts.aebi), [] vs undefined 走不同分支!)
  win['$_ts'] = {
    nsd,
    cd,
  };



  // ================================================================
  // ★★★ fakePTS 安装 (2026-08-19): 替换沙箱 Function.prototype.toString
  //   VM 用 Function.prototype.toString.call(fn) 绕过 own toString 读 [[SourceText]]:
  //     - B 函数 (__anonSrc) → 'function anonymous(...)' 形态
  //     - JS_TEXT 查表 (jsdom 精确文本: class 完整源码 / JS 方法源码 / native 文本)
  //     - NATIVE_FNS 兜底 → 'function X() { [native code] }'
  //     - 其余 → origPTS (VM 自己的函数 / 沙箱内置 — 与 jsdom 的原生行为一致)
  //   ★ 查表不要求 ENV_FNS: jsdom 子对象方法 (document.createElement 等) 未注册 —
  //     但 VM 函数名带 _$ 前缀, jsdom_texts.json 里不存在 → 天然不冲突
  // ================================================================
  installFakePTS = installFakePTS || null;  // ★ run_vm.js 用来装进 ctx realm (2026-08-19) — 顶层声明见文件头
  {
    const origPTS = Function.prototype.toString;
    const fakePTS = function () {
      if (typeof this !== 'function') return origPTS.call(this);
      try {
        if (this.__srcText) return this.__srcText;                       // 显式 jsdom 源码 (XHR/history/Navigator 方法)
        if (this.__anonSrc) return this.__anonSrc;                       // B 函数 (new Function 产物)
        // ★★★ 2026-08-19 (task 1564): jsdom getter toString = 'get xxx() {...}' 源码形态
        //   (非 'function get()...') — __getterName 查表 (xhr_get_* 等从 jsdom 抓取)
        if (this.__getterName) {
          const gt = JS_TEXT[this.__getterName];
          if (gt) return gt.text;
        }
        const nm = this.__natName || this.name;                          // setGlobal 键优先 (DP 等 name 为空)
        const t = JS_TEXT[nm];
        // ★ 查表仅限 env 标记函数 (VM 内部函数 name 巧合重名不得查表 → 源码)
        if (t && (NATIVE_FNS.has(this) || ENV_FNS.has(this) || this.__natName)) return t.text;
        // ★★★ 2026-08-19 (task 1564): getter 查表必须在'get'特判之前 —
        //   jsdom window.get = 事件处理器 getter (JS_TEXT['get'] 源码), 特判优先 → native 文本分叉
        if (nm === 'get' && NATIVE_FNS.has(this)) return 'function get() { [native code] }';
        if (NATIVE_FNS.has(this)) {
          return 'function ' + (this.__natName || nm || '') + '() { [native code] }';
        }
        // ★ run_vm.js 内部函数 (ctxFunction/ctxEval/eval wrapper) — jsdom 对等物是原生
        if (this.__natName) {
          const t2 = JS_TEXT[nm];
          if (t2) return t2.text;
          return 'function ' + nm + '() { [native code] }';
        }
      } catch (e) {}
      return origPTS.call(this);
    };
    Object.defineProperty(fakePTS, 'name', { value: 'toString', configurable: true });
    Object.defineProperty(fakePTS, 'length', { value: 0, configurable: true });
    Object.defineProperty(fakePTS, 'toString', {
      value: () => 'function toString() { [native code] }', configurable: true,
    });
    // ★★★ 沙箱 realm 安装 (2026-08-19): VM 代码在 ctx realm 执行, fn.toString / String(fn)
    //   走 ctx 的 %Function%.prototype.toString — 主 realm 的 fakePTS 覆盖不到!
    //   → task 852 分叉: N=function () { [native code] } (bound 匿名) vs S=function open() { [native code] }
    //   → VM 指纹收集函数字符串 → FV_IN 明文分叉 → 400
    //   run_vm.js 在 buildEnv 后调用 installFakePTS(SANDBOX_FUNCTION) 装进 ctx realm
    installFakePTS = (FCtor) => {
      try {
        Object.defineProperty(FCtor.prototype, 'toString', {
          value: fakePTS, writable: true, configurable: true, enumerable: false,
        });
        log('[FPT] sandbox fakePTS installed');
      } catch (e) { log('[FPT] sandbox install err: ' + e.message); }
    };
    Function.prototype.toString = fakePTS;
    log('[FPT] fakePTS installed, jsdom_texts=' + Object.keys(JS_TEXT).length);
  }

  if (process.env.ENV_STOP) {
    const __st = parseInt(process.env.ENV_STOP);
    const __r = []; for (const __k in win) { __r.push(__k); if (__r.length > 400) break; }
    console.error('[ENV-STOP] hasProto=' + __r.includes('removeEventListener'));
    if (__st === 1) process.exit(0);
  }

  if (debug) log('[MM-PROBE] win.matchMedia === _matchMediaWrap: ' + (win.matchMedia === _matchMediaWrap) + ' typeof=' + typeof win.matchMedia + ' src=' + String(win.matchMedia).slice(0, 80));
  return { win, doc: _doc, getCookie: () => _docCookie, host, origin, log };
}

// ★ installFakePTS 用 getter 导出: buildEnv 首次调用时才赋值, 普通对象导出会拷到 null
module.exports = { buildEnv, get installFakePTS() { return installFakePTS; } };
