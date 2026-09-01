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
  } = opts;

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
      Object.defineProperty(win, key, { value, writable: true, configurable: true });
    } catch (e) {
      win[key] = value;
    }
  };
  setGlobal('window', win);
  setGlobal('self', win);
  setGlobal('top', win);
  setGlobal('parent', win);
  setGlobal('frames', win);

  // ★ native 形态伪装: toString 返回 [native code] (jsdom 实测形态)
  const makeNative = (name, src) => {
    const fn = function () { };
    Object.defineProperty(fn, 'name', { value: name, configurable: true });
    Object.defineProperty(fn, 'toString', {
      value: () => src || `function ${name}() { [native code] }`,
    });
    return fn;
  };
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
    // document 原型
    const docNode = mkProto('Document', node.proto);
    return { map, docProto: docNode.proto, docCtor: docNode.ctor };
  };
  const _pchain = buildProtoChain();
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
        return v.apply(this, args);
      };
      Object.defineProperty(wrapped, 'name', { value: k, configurable: true });
      Object.defineProperty(wrapped, 'toString', {
        value: () => `function ${k}() { [native code] }`,
      });
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
  setGlobal('navigator', {
    userAgent: ua,
    appVersion: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    platform: 'Win32',
    language: 'zh-CN',
    languages: ['zh-CN', 'zh', 'en-US', 'en'],
    cookieEnabled: true,
    webdriver: false,
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
    plugins: {
      length: 5,
      0: { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: '' },
      1: { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
      2: { name: 'Native Client', filename: 'internal-nacl-plugin' },
      item(i) { return this[i] || null; },
      namedItem() { return null; },
      refresh() { },
    },
    mimeTypes: {
      length: 4,
      0: { type: 'application/pdf', suffixes: 'pdf', description: '' },
      1: { type: 'text/pdf', suffixes: 'pdf' },
      2: { type: 'application/x-google-chrome-pdf', suffixes: 'pdf' },
      3: { type: 'application/x-nacl', suffixes: '' },
      item(i) { return this[i] || null; },
      namedItem() { return null; },
    },
  });

  // ================================================================
  // Screen — 对齐 sdenv/jsdom 实测值
  // ================================================================
  setGlobal('screen', {
    width: 0, height: 0, availWidth: 0, availHeight: 0,
    availLeft: undefined, availTop: undefined,
    colorDepth: 24, pixelDepth: 24,
    orientation: { type: 'landscape-primary', angle: 0, onchange: null },
  });

  // ================================================================
  // Location (★ 拦截 redirect)
  // ================================================================
  setGlobal('location', {
    href: url, protocol: proto, host, hostname: host,
    port: '', pathname, search: '', hash: '', origin,
    ancestorOrigins: {},
    replace(newUrl) { log(`[BLOCKED] location.replace → ${newUrl}`); },
    assign() { }, reload() { },
    toString() { return url; },
    valueOf() { return url; },
  });
  setGlobal('history', {
    length: 3, state: null, scrollRestoration: 'auto',
    pushState() { }, replaceState() { }, back() { }, forward() { }, go() { },
  });

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
  let scriptEl = makeInlineScript(inlineScripts[0] || '');
  const scriptEl2 = makeInlineScript(inlineScripts[1] || '');

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
    children: [metaEl, scriptEl, scriptEl2], childNodes: [metaEl, scriptEl, scriptEl2],
    appendChild(c) { if (c) { c.parentNode = _head; c.parentElement = _head; } this.children.push(c); this.childNodes.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); this.childNodes.splice(i, 1); } if (c) { c.parentNode = null; c.parentElement = null; } return c; },
    getElementsByTagName(tag) {
      const t = (tag || '').toLowerCase();
      if (t === 'meta') return makeCollection([metaEl]);
      if (t === 'script') return makeCollection([scriptEl, scriptEl2]);
      return makeCollection([]);
    },
    querySelectorAll() { return makeCollection([]); },
    parentNode: null, parentElement: null,
  });
  metaEl.parentNode = _head; metaEl.parentElement = _head;
  scriptEl.parentNode = _head; scriptEl.parentElement = _head;
  scriptEl2.parentNode = _head; scriptEl2.parentElement = _head;
  _setProto(metaEl, 'meta');
  _setProto(scriptEl, 'script');
  _setProto(triggerScriptEl, 'script');
  _setProto(_head, 'head');

  const _body = nativeifyMethods({
    nodeName: 'BODY', tagName: 'BODY', nodeType: 1,
    getAttribute() { return null; }, hasAttribute() { return false; },
    setAttribute() { }, removeAttribute() { }, attributes: {},
    children: [], childNodes: [], innerHTML: '', innerText: '', textContent: '',
    appendChild(c) { if (c) { c.parentNode = _body; c.parentElement = _body; } this.children.push(c); this.childNodes.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); this.childNodes.splice(i, 1); } if (c) { c.parentNode = null; c.parentElement = null; } return c; },
    getElementsByTagName() { return makeCollection([]); },
    querySelectorAll() { return makeCollection([]); },
    style: {}, parentNode: null, parentElement: null,
  });

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
    appendChild(c) { if (c) { c.parentNode = documentElement; c.parentElement = documentElement; } this.children.push(c); this.childNodes.push(c); return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) { this.children.splice(i, 1); this.childNodes.splice(i, 1); }
      if (c) { c.parentNode = null; c.parentElement = null; }
      return c;
    },
  });

  const _doc = nativeifyMethods({
    nodeType: 9, nodeName: '#document',
    head: _head, body: _body,
    documentElement,

    // ★ Cookie 拦截
    get cookie() { return _docCookie; },
    set cookie(value) {
      const parts = String(value).split(';');
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
      // ★ 活集合: 从当前树状态计算 (VM 的 while(len) remove 循环依赖集合收缩)
      if (t === 'meta') return makeCollection([metaEl].filter(m => m.parentNode));
      if (t === 'script') return makeCollection([scriptEl, scriptEl2].filter(s => s.parentNode));
      if (t === 'head') return makeCollection([_head]);
      if (t === 'body') return makeCollection([_body]);
      if (t === 'html') return makeCollection([documentElement]);
      if (t === '*') return makeCollection([_head, _body, metaEl, scriptEl, scriptEl2].filter(e => e.parentNode));
      return makeCollection([]);
    },
    getElementById(id) { return id === metaId && metaEl.parentNode ? metaEl : null; },
    querySelectorAll(sel) { return sel && sel.includes('meta') ? makeCollection([metaEl]) : makeCollection([]); },
    querySelector(sel) { return (sel && sel.includes('meta')) ? metaEl : null; },
    getElementsByClassName() { return makeCollection([]); },
    getElementsByName() { return makeCollection([]); },

    createElement(tag) {
      const t = (tag || '').toLowerCase();
      const _attrs = {};
      let _pn = null, _pe = null;
      const el = nativeifyMethods({
        nodeName: t.toUpperCase(), tagName: t.toUpperCase(), nodeType: 1,
        children: [], childNodes: [], innerHTML: '', innerText: '', style: {},
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
      _setProto(el, t);
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
      // action 反射 (form): 设置时解析为绝对 URL (浏览器行为)
      if (t === 'form') {
        let _action = '';
        Object.defineProperty(el, 'action', {
          get() { return _action; },
          set(v) {
            _action = String(v);
            try { _action = new URL(String(v), origin + '/').href; } catch (e) {}
            _attrs.action = _action;
          },
          configurable: true,
        });
      }
      if (t === 'form') {
        el.submit = function () { }; el.reset = function () { };
        // ★ form.length / elements: 控件活计数 (随 appendChild 更新)
        const _controls = () => (el.children || []).filter(c =>
          ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(c.tagName));
        Object.defineProperty(el, 'length', {
          get() { return _controls().length; },
          configurable: true,
        });
        Object.defineProperty(el, 'elements', {
          get() { return makeCollection(_controls()); },
          configurable: true,
        });
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
    },

    addEventListener(type, cb) { win.addEventListener(type, cb); },
    appendChild(c) { if (c) { c.parentNode = _doc; } return this.documentElement.appendChild(c); },
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
    title: '', domain: host, URL: url, documentURI: url, referrer: '',
    // ★ document.all: 浏览器中 typeof 为 'undefined' 但值是对象 (jsdom 实测 [object Object])
    all: (function () {
      const coll = {};
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
  try { Object.setPrototypeOf(_doc, _pchain.docProto); } catch (e) {}
  setGlobal('document', _doc);

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
  setGlobal('localStorage', {
    getItem(k) { return _ls.hasOwnProperty(k) ? _ls[k] : null; },
    setItem(k, v) { _ls[k] = String(v); }, removeItem(k) { delete _ls[k]; },
    clear() { for (const k in _ls) delete _ls[k]; },
    key(i) { return Object.keys(_ls)[i] || null; },
    get length() { return Object.keys(_ls).length; },
  });
  setGlobal('sessionStorage', {
    getItem(k) { return _ss.hasOwnProperty(k) ? _ss[k] : null; },
    setItem(k, v) { _ss[k] = String(v); }, removeItem(k) { delete _ss[k]; },
    clear() { for (const k in _ss) delete _ss[k]; },
    key(i) { return Object.keys(_ss)[i] || null; },
    get length() { return Object.keys(_ss).length; },
  });

  // ================================================================
  // Network (空 XHR — 挑战页不出网)
  // ================================================================
  const XHR = makeNative('XMLHttpRequest', 'class XMLHttpRequest extends EventTarget { [native code] }');
  XHR.prototype.constructor = XHR;
  const _XHRWrap = function XMLHttpRequest() { };
  Object.setPrototypeOf(_XHRWrap, XHR);
  Object.setPrototypeOf(_XHRWrap.prototype, XHR.prototype);
  Object.defineProperty(_XHRWrap, 'toString', { value: () => 'class XMLHttpRequest extends EventTarget { [native code] }' });
  XHR.prototype = {
    open() { }, send() { }, setRequestHeader() { }, getResponseHeader() { return null; },
    getAllResponseHeaders() { return ''; }, abort() { }, addEventListener() { },
    overrideMimeType() { },
    get UNSENT() { return 0; }, get OPENED() { return 1; },
    get HEADERS_RECEIVED() { return 2; }, get LOADING() { return 3; }, get DONE() { return 4; },
  };
  XHR.UNSENT = 0; XHR.OPENED = 1; XHR.HEADERS_RECEIVED = 2;
  XHR.LOADING = 3; XHR.DONE = 4;
  setGlobal('XMLHttpRequest', XHR);
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
  const _st = setTimeout, _si = setInterval, _ct = clearTimeout, _ci = clearInterval;
  // ★ 实验: 不吞 timer 异常 (暴露 phase-2 入口的缺失 API)
  setGlobal('setTimeout', function (fn, d) {
    return typeof fn === 'function' ? _st(() => {
      try { fn(); } catch (e) {
        log('[TIMER-ERR] ' + e.message + ' | ' + (e.stack || '').split('\n')[1]);
        throw e;
      }
    }, d || 0) : 0;
  });
  setGlobal('setInterval', function (fn, d) {
    return typeof fn === 'function' ? _si(() => {
      try { fn(); } catch (e) {
        log('[TIMER-ERR] ' + e.message + ' | ' + (e.stack || '').split('\n')[1]);
        throw e;
      }
    }, d || 0) : 0;
  });
  setGlobal('clearTimeout', _ct);
  setGlobal('clearInterval', _ci);

  // ================================================================
  // 其他 API
  // ================================================================
  setGlobal('performance', {
    now() { return Date.now() - 1000000; },
    timing: {
      navigationStart: Date.now() - 2000, loadEventEnd: Date.now() - 1000,
      domComplete: Date.now() - 500, domainLookupEnd: Date.now() - 1500,
      connectEnd: Date.now() - 1200, responseEnd: Date.now() - 800,
    },
    navigation: { type: 0, redirectCount: 0 },
    getEntries() { return []; }, getEntriesByType() { return []; }, getEntriesByName() { return []; },
    mark() { }, measure() { }, clearMarks() { }, clearMeasures() { },
    memory: { jsHeapSizeLimit: 4294967296, totalJSHeapSize: 10000000, usedJSHeapSize: 8000000 },
  });

  if (opts.crypto || globalThis.crypto) {
    setGlobal('crypto', opts.crypto || globalThis.crypto);
  } else {
    const _grv = function getRandomValues(arr) { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; };
    Object.defineProperty(_grv, 'toString', { value: () => 'function getRandomValues() { [native code] }' });
    const _ruid = function randomUUID() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); }); };
    Object.defineProperty(_ruid, 'toString', { value: () => 'function randomUUID() { [native code] }' });
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
  setGlobal('URL', (win === globalThis && globalThis.URL) || { createObjectURL() { return 'blob:mock'; }, revokeObjectURL() { } });
  if (!hasNativeBlob) {
    win.Blob.prototype = { slice() { return new win.Blob(); }, get size() { return 0; }, get type() { return ''; } };
  }

  const _atobFn = function atob(s) { return Buffer.from(String(s), 'base64').toString('binary'); };
  Object.defineProperty(_atobFn, 'toString', { value: () => 'function atob() { [native code] }' });
  const _btoaFn = function btoa(s) { return Buffer.from(String(s), 'binary').toString('base64'); };
  Object.defineProperty(_btoaFn, 'toString', { value: () => 'function btoa() { [native code] }' });
  setGlobal('atob', _atobFn);
  setGlobal('btoa', _btoaFn);
  setGlobal('eval', eval);

  const _matchMediaFn = makeNative('matchMedia');
  setGlobal('matchMedia', _matchMediaFn);
  setGlobal('getComputedStyle', makeNative('getComputedStyle'));
  const _rafFn = makeNative('requestAnimationFrame');
  setGlobal('requestAnimationFrame', function (cb) { return _st(cb, 16); });
  win.requestAnimationFrame.toString = _rafFn.toString;
  const _cafFn = makeNative('cancelAnimationFrame');
  setGlobal('cancelAnimationFrame', function (id) { _ct(id); });
  win.cancelAnimationFrame.toString = _cafFn.toString;

  setGlobal('open', function () { return null; });
  setGlobal('close', function () { });
  setGlobal('alert', function () { });
  setGlobal('confirm', function () { return true; });
  setGlobal('prompt', function () { return null; });
  setGlobal('print', function () { });
  setGlobal('postMessage', function () { });
  setGlobal('scrollTo', function () { });
  setGlobal('scrollBy', function () { });
  // ★ addEventListener: 存储监听器; 'load' 回调等待 time-0 timer 链完成 (sdenv 同款, 瑞数依赖)
  const _listeners = {};
  win.addEventListener = function (type, cb) {
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
          cb(...params);
        })();
      }
      cb(...params);
    };
    _listeners[type].push(wrapped);
  };
  win.removeEventListener = function (type, cb) {
    if (_listeners[type]) _listeners[type] = _listeners[type].filter((f) => f !== cb);
  };
  win.dispatchLoad = function () {
    for (const f of (_listeners.load || [])) {
      // ★ 异常隔离: VM 的探针 (如 parentNode 只读检测) 靠抛异常探测浏览器行为,
      //   sdenv 的 timer try/catch 会吞掉 — 这里同步调用必须同样隔离
      try { f({ type: 'load' }); } catch (e) { log('[LOAD-ERR] ' + e.message); }
    }
  };
  setGlobal('dispatchEvent', function () { return true; });
  setGlobal('attachEvent', function () { return true; });
  setGlobal('detachEvent', function () { });

  win.innerWidth = 1024; win.innerHeight = 768;
  win.outerWidth = 1024; win.outerHeight = 768;
  win.screenX = 0; win.screenY = 0; win.screenLeft = 0; win.screenTop = 0;
  win.devicePixelRatio = 1;
  win.scrollX = 0; win.scrollY = 0; win.pageXOffset = 0; win.pageYOffset = 0;
  win.length = 0;
  win.frameElement = null; win.name = '';
  // ★ window.chrome: jsdom 实测为空对象 {} (不要带 loadTimes/csi/app — 形状会进指纹)
  setGlobal('chrome', {});
  setGlobal('external', {});
  setGlobal('Intl', (win === globalThis && globalThis.Intl) || {});

  // 与 sdenv/jsdom 实测对齐:
  // ★ 存在的 API (native 形态)
  setGlobal('RTCPeerConnection', makeNative('RTCPeerConnection'));
  setGlobal('webkitRTCPeerConnection', makeNative('webkitRTCPeerConnection'));
  setGlobal('Worker', makeNative('Worker'));
  setGlobal('WebSocket', makeNative('WebSocket', 'class WebSocket extends EventTarget { [native code] }'));
  setGlobal('indexedDB', { open() { return {}; } });
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

  return { win, doc: _doc, getCookie: () => _docCookie, host, origin, log };
}

module.exports = { buildEnv };
