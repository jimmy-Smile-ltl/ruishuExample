/**
 * native_patch.js — 函数原生伪装层 (setFuncNative, 零依赖)
 *
 * 瑞数 VM 逐个检测 window 函数的 toString 是否 native。
 * 原理: 白名单函数名 + 每函数自定义 toString 返回
 *   `function <本名>() { [native code] }`。
 *
 * 来源: 从 build_env_jsdom.js 实验层提取 (2026-08-15),
 * 供纯手写 build_env.js 复用。
 */

function installNativePatches(win, log) {
  const canToStrigArr = [];
  const originToString = Function.prototype.toString;
  const nativeToString = function () {
    if (canToStrigArr.includes(this.name)) {
      return `function ${this.name || ''}() { [native code] }`;
    }
    return originToString.call(this);
  };
  function setFuncNative(func, name, len) {
    if (!func) return undefined;
    if (typeof name === 'string') Object.defineProperty(func, 'name', { value: name });
    else if (typeof name === 'number') len = name;
    if (typeof len === 'number') Object.defineProperty(func, 'length', { value: len });
    canToStrigArr.push(func.name);
    Object.defineProperty(func, 'toString', {
      enumerable: false, configurable: true, writable: true, value: nativeToString,
    });
    return func;
  }
  setFuncNative(nativeToString, 'toString');
  try { win.Function.prototype.toString = nativeToString; } catch (e) { }
  try { nativeToString.__proto__ = win.Function.prototype; } catch (e) { }

  // 函数清单 (sdenv browser/chrome 全部 setFuncNative 调用点)
  for (const [target, name, len] of [
    // timer / 基础 window
    [win, 'setTimeout', 1], [win, 'setInterval', 1],
    [win, 'clearTimeout', 0], [win, 'clearInterval', 0],
    [win, 'requestAnimationFrame', 1], [win, 'cancelAnimationFrame', 1],
    [win, 'webkitRequestAnimationFrame', 1], [win, 'webkitCancelAnimationFrame', 1],
    [win, 'queueMicrotask', 1],
    [win, 'atob', 1], [win, 'btoa', 1],
    // 弹窗/窗口
    [win, 'alert', 0], [win, 'confirm', 0], [win, 'prompt', 0],
    [win, 'print', 0], [win, 'open', 0], [win, 'close', 0],
    [win, 'focus', 0], [win, 'blur', 0], [win, 'stop', 0],
    [win, 'moveTo', 2], [win, 'moveBy', 2], [win, 'resizeTo', 2], [win, 'resizeBy', 2],
    [win, 'captureEvents', 0], [win, 'releaseEvents', 0],
    [win, 'scroll', 0], [win, 'scrollTo', 0], [win, 'scrollBy', 0],
    // DOM / 查询
    [win, 'getComputedStyle', 1], [win, 'getSelection', 0],
    [win, 'postMessage', 1], [win, 'find', 0],
    [win, 'fetch', 1], [win, 'createImageBitmap', 1],
    [win, 'reportError', 1], [win, 'structuredClone', 1],
    [win, 'requestIdleCallback', 1], [win, 'cancelIdleCallback', 1],
    [win, 'webkitResolveLocalFileSystemURL', 1],
    // 事件
    [win, 'Event', 1], [win, 'CustomEvent', 1],
    // 网络 / Worker
    [win, 'Request', 1], [win, 'Worker', 1],
    // 媒体
    [win, 'matchMedia', 1], [win, 'MediaQueryList', 1],
    // 原型方法
    [win.Date ? win.Date.prototype : null, 'getTime', 0],
    [win.HTMLCanvasElement ? win.HTMLCanvasElement.prototype : null, 'toDataURL', 0],
    [win.HTMLCanvasElement ? win.HTMLCanvasElement.prototype : null, 'toBlob', 1],
    [win.location, 'replace', 1], [win.location, 'assign', 1],
    [win.navigator, 'sendBeacon', 1],
    [win.console, 'log', 0], [win.console, 'warn', 0], [win.console, 'error', 0],
  ]) {
    try {
      const fn = typeof target === 'function' ? target : (target && target[name]);
      if (fn) setFuncNative(fn, name, len);
    } catch (e) { }
  }

  // eval 伪装 native (33 chars)
  try {
    const origEval = win.eval;
    const fakeEval = function (code) { return origEval(code); };
    fakeEval.toString = () => 'function eval() { [native code] }';
    Object.defineProperty(win, 'eval', { value: fakeEval, configurable: true });
  } catch (e) { }

  // Window 构造函数 + 原型链伪造 (文章技巧: window instanceof Window 检测)
  try {
    const WindowCtor = function Window() { };
    Object.defineProperty(WindowCtor.prototype, 'constructor', { value: WindowCtor, configurable: true });
    win.__proto__ = WindowCtor.prototype;
    win.constructor = WindowCtor;
    setFuncNative(WindowCtor, 'Window', 0);
  } catch (e) { }

  if (log) log(`[NATIVE] ${canToStrigArr.length} 个函数已伪装 native`);
  return { nativeToString, setFuncNative };
}

module.exports = { installNativePatches };
