/**
 * run_vm.js — 手写补环境跑瑞数挑战页 VM, 输出 P-cookie
 *
 * 用法:
 *   node run_vm.js <挑战页html> <页面URL> [vm.js路径] [--debug] [等待秒=8]
 *
 * 流程:
 *   1. 解析挑战页: nsd/cd/meta/script src/触发函数
 *   2. 构建手写浏览器环境 (env.js)
 *   3. eval VM → 调触发 ($_ts.lcd / _$cl / 内联触发函数)
 *   4. 轮询 document.cookie → stdout 输出
 */
const fs = require('fs');
const path = require('path');
const { buildEnv } = require('./env.js');

// ★ 2026-08-19: UA 与回放链一致 — 所有链脚本 (test_nodenv_chain.py/dual_chain.py/
//   final_pipeline.py/quick_replay.py/replay_same_round.py) 全部 Windows Chrome/138。
//   服务端校验 cookie 指纹 UA == 请求 UA; env.js:22 navigator 同样 138 —
//   之前 Mac/131 导致指纹与回放头不一致 → 400 (headless 探测任务缺失假设已排除:
//   探测任务由 VM 代码分支决定, 与 UA 无关)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

function log(msg) {
  process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

function setGlobal2Eval(win, origEval, caps, logFn, debug, traceTask) {
  // ★ eval 包装: 生产模式只捕获不重写 (代码重写会改变 VM 生成代码语义!)
  Object.defineProperty(win, '__dbg', { value: (m) => logFn('[DBG] ' + m), writable: true, configurable: true, enumerable: false });
  Object.defineProperty(win, '__dbgIdx', { value: 0, writable: true, configurable: true, enumerable: false });
  // ★★★ 2026-08-19: 生产模式不劫持 eval — ctx.eval 已是 accessor 返回原生 SANDBOX_EVAL (571 行),
  //   保证 VM 直接 eval 的 this 语义 (this.a=1 → 新对象而非 ctx 全局)
  if (!debug && !traceTask) return;
  const wrapped = function (code) {
    // ★ 短代码片段调用栈记录 (const l / Z8XHJJY 重复触发来源定位)
    if (typeof code === 'string' && (code.includes('Z8XHJJY') || /^(const|let|var) l=1;/.test(code))) {
      try {
        require('fs').appendFileSync('short_eval_stacks.txt',
          String.fromCharCode(10) + '/* ' + Date.now() + ' ' + code.slice(0, 40) + ' */' +
          String.fromCharCode(10) + String(new Error().stack).slice(0, 1500), 'utf-8');
      } catch (e2) {}
    }
    if (typeof code === 'string' && code.length > 50) {
      caps.push(code);
      logFn(`[EVAL] captured ${code.length}b (total ${caps.length})`);
      if (traceTask) {
        // 防双重插桩: 已含 __oplog 标记(插桩产物)则跳过
        if (code.includes('__oplog')) {
          logFn(`[EVAL] skip already-instrumented ${code.length}b`);
        } else {
          code = traceTaskExec(code, logFn);
          // ★ 2026-08-31: boot/KH 插桩须在此 (主 chunk 走 wrapped 路径, 不经 _rawEval)
          if (code.length >= 400000) {
            code = instrumentBoot(code, logFn);
            code = instrumentKHCtor(code, logFn);
          }
        }
      }
      if (debug) {
        code = rewriteForDebug(code, logFn);
      }
    }
    // ★★★ 2026-08-19 this 语义修复: 直接 eval 的 this = 调用者 this (new function(){eval("this.a=1")} → 新对象)
    //   之前 origEval(code) 丢失 this → call(ctx) 强制 this=ctx → ctx.a=1 泄漏全局键 'a' (S 侧无) → 指纹分叉
    try { return origEval.call(this, code); } catch (e) { if (e && /SyntaxError|Unexpected/.test(String(e.message))) { require('fs').writeFileSync('broken_chunk.js', code, 'utf-8'); log('[SYN-DUMP] broken_chunk.js saved'); } throw e; }
  };
  // ★ native 形态: 指纹会检查 eval.toString() (fakePTS 按 __natName 查表返回)
  Object.defineProperty(wrapped, 'name', { value: 'eval', configurable: true });
  Object.defineProperty(wrapped, '__natName', { value: 'eval', configurable: true });
  win.eval = wrapped;
}

// ★ 任务执行器调用追踪 (名字无关: 变量名每轮随机, 靠结构特征匹配)
//   结构: function F(p1,p2,p3,p4){var NAMES; A=p1.PROP, B=p4[2], C=p4[3], D=p4[0], E=p4[1], STK=X.Y(), CUR=0;
const { traceTaskExec, instrumentMainChunk, instrumentBoot, instrumentKHCtor } = require('./trace_hooks.js');

// ★ VM-RIC monkey patch (与 sd_trace.js 同款): 主 chunk 静态代码也插桩
//   nodenv 之前只有 Function/eval 两个动态入口 → 336B Feistel 调用发生在主 chunk (盲区)
//   加 VM-RIC 后主 chunk (>5000b) 也走 traceTaskExec → 336B FV_IN 可捕获
//   ★ --no-instrument: 干净模式 (链式验证用, 无插桩无 __oplog, 快)
const NO_INSTRUMENT = process.argv.includes('--no-instrument');
const vmMod = require('vm');
const _runInContext = vmMod.runInContext;
vmMod.runInContext = function (code, ctx, opts) {
  if (!NO_INSTRUMENT && typeof code === 'string' && code.length > 5000) {
    if (code.includes('__oplog') || code.startsWith('Function(')) {
      log('[VM-RIC] skip already-instrumented ' + code.length + 'b');
    } else {
      log('[VM-RIC] ' + code.length + 'b');
      try {
        require('fs').writeFileSync('ric_vmric_' + code.length + '.js', code, 'utf-8');
        code = traceTaskExec(code, log);
      } catch (e) { log('[VM-RIC] hook err: ' + e.message); }
    }
  }
  // ★ 落盘所有执行失败的代码 (const l 冲突 / Z8XHJJY 未定义 的源头)
  try {
    const r = _runInContext.call(this, code, ctx, opts);
    return r;
  } catch (e) {
    try {
      const sc = String(code);
      if (sc.length < 200000) {
        require('fs').appendFileSync('err_code.js',
          String.fromCharCode(10) + '/* ==== ERR ' + String(e && e.message).slice(0, 80) +
          ' (' + sc.length + 'b) ==== */' + String.fromCharCode(10) + sc, 'utf-8');
        log('[RIC-ERR] ' + String(e && e.message).slice(0, 60) + ' code=' + sc.length + 'b');
      }
    } catch (e2) {}
    // ★ 异常时刻的 oplog/evlog 尾部 — 关联到具体任务段与 opcode (append 模式, 每个异常一条)
    try {
      // ★ 干净模式(__oplog 未定义)下不能直接用 __oplog||[] — ReferenceError 导致诊断循环
      const tail = vmMod.runInContext(
        'JSON.stringify({op: (typeof __oplog!=="undefined"?__oplog:[]).slice(-25), ev: (typeof __evlog!=="undefined"?__evlog:[]).slice(-8)})', ctx);
      require('fs').appendFileSync('exn_oplog_tail.json',
        JSON.stringify({ msg: String(e && e.message), time: Date.now(),
          codeLen: String(code).length, tail: JSON.parse(tail) }) + String.fromCharCode(10), 'utf-8');
      log('[EXN-OPLOG] #' + String(e && e.message).slice(0, 40));
      log('[EXN-STACK] ' + String((e && e.stack) || '').split(String.fromCharCode(10)).slice(0, 8).join(' | '));
    } catch (e2) { log('[EXN-OPLOG] ctx read err: ' + (e2 && e2.message)); }
    throw e;
  }
};

function rewriteForDebug(code, logFn) {
  // 1. 构造分发器: ctor + args 记录; new 失败时 dump ctor 的 typeof/来源
  const dispRe = /function (_\$\w+)\((_\$\w+),(_\$\w+)\)\{if\(\3\.length===0\)return new \2\(\);/;
  if (dispRe.test(code)) {
    code = code.replace(dispRe, function (m, fname, ctor, arr) {
      return 'function ' + fname + '(' + ctor + ',' + arr +
        '){var __t=typeof ' + ctor + ';var __s="";try{__s=String(' + ctor +
        ').slice(0,80)}catch(e){}try{__dbg("CTOR:"+__t+"|"+__s+" args="+' + arr +
        '.length)}catch(e){}if(' + arr + '.length===0){try{return new ' + ctor +
        '();}catch(__ce){try{__dbg("CTOR-FAIL:"+__t+"|"+__s+"|"+(__ce&&__ce.message).slice(0,60))}catch(e){}throw __ce;}}' +
        'if(' + arr + '.length===1)return new ' + ctor + '(' + arr +
        '[0]);if(' + arr + '.length===2)return new ' + ctor + '(' + arr + '[0],' + arr +
        '[1]);if(' + arr + '.length===3)return new ' + ctor + '(' + arr + '[0],' + arr +
        '[1],' + arr + '[2]);return new ' + ctor + '(' + arr + '[0],' + arr + '[1],' + arr +
        '[2],' + arr + '[3]);';
    });
    logFn('[EVAL] dispatcher instrumented');
  }
  // 2. 最外层 boot 解释器: while(1){OP=ARR[IDX++];if(OP<27){
  const bootRe = /(while\(1\)\{)(_\$\w+)=(_\$\w+)\[(_\$\w+)\+\+\];if\(\2<27\)\{/;
  if (bootRe.test(code)) {
    code = code.replace(bootRe, function (m, head, opv, arrv, idxv) {
      return head + 'try{__dbg("BOOT:"+__dbgIdx+++" op="+' + arrv + '[' + idxv + '])}catch(e){};' +
        opv + '=' + arrv + '[' + idxv + '++];if(' + opv + '<27){';
    });
    logFn('[EVAL] boot loop instrumented');
  }
  // 2.4. 方法调用接收者插桩: X=X[KEY], (调用前记录 X)
  const rcvRe = new RegExp('(_[\\$\\w]+)=\\1' + '\\[' + '(_[\\$\\w]+)' + '\\]' + ',');
  if (rcvRe.test(code)) {
    code = code.replace(rcvRe, function (m, objv, keyv) {
      return objv + '=' + objv + '[' + keyv + '],__dbg("RCV:"+String(' + objv + ').slice(0,25)+"."+String(' + keyv + ')),';
    });
    logFn('[EVAL] rcv instrumented');
  }
  // 2.45. opcode-13 单参方法调用插桩: ,X=Z[K](a) → 前置逗号日志
  const rcv1Re = /,(_\$\w+)=(_\$\w+)\[(_\$\w+)\]\(/;
  if (rcv1Re.test(code)) {
    code = code.replace(rcv1Re, function (m, resv, objv, keyv) {
      return ',__dbg("RCV1:"+String(' + objv + ').slice(0,25)+"."+String(' + keyv + ')),' + resv + '=' + objv + '[' + keyv + '](';
    });
    logFn('[EVAL] rcv1 instrumented');
  }
  // 3. 子解释器 _$fX 型: while(1){OP=ARR[IDX++];if(OP<4){if(OP===0){return;
  const subRe = /(while\(1\)\{)(_\$\w+)=(_\$\w+)\[(_\$\w+)\+\+\];if\(\2<4\)\{if\(\2===0\)\{return;/;
  if (subRe.test(code)) {
    code = code.replace(subRe, function (m, head, opv, arrv, idxv) {
      return head + 'try{__dbg("SUB:"+__dbgIdx+++" op="+' + arrv + '[' + idxv + '])}catch(e){};' +
        opv + '=' + arrv + '[' + idxv + '++];if(' + opv + '<4){if(' + opv + '===0){return;';
    });
    logFn('[EVAL] sub loop instrumented');
  }
  return code;
}

// 兜底: 异步探针链的 unhandled rejection 不杀死进程 (只记日志)
process.on('unhandledRejection', (e) => {
  log('[UNHANDLED] ' + (e && e.message ? e.message : String(e)));
});

async function main() {
  const htmlFile = process.argv[2];
  const pageUrl = process.argv[3];
  let vmPath = process.argv[4];
  const args = process.argv.slice(4);
  const debug = args.includes('--debug');
  const fixDate = args.includes('--fixdate');  // 实验: 固定时间 (定位 cookie 时间来源)
  const seqMode = debug || args.includes('--seq');  // --seq: 观测开, 代码重写关
  const traceTask = args.includes('--trace-task');  // 捕获 _$fB 任务执行器调用
  const cp4Idx = args.indexOf('--cp4');
  const cp4Fix = cp4Idx > -1 ? parseInt(args[cp4Idx + 1]) : null;
  const waitIdx = args.indexOf('--wait');
  const waitSec = waitIdx > -1 ? parseInt(args[waitIdx + 1] || '8') : 8;
  if (vmPath && vmPath.startsWith('--')) vmPath = null;

  const html = fs.readFileSync(htmlFile, 'utf-8');

  // ── 1. 解析挑战页配置 ──────────────────────────────────────
  const nsd = parseInt((html.match(/\$_ts\.nsd\s*=\s*(\d+)/) || [])[1] || '0');
  const cd = (html.match(/\$_ts\.cd\s*=\s*"([^"]+)"/) || [])[1] || '';
  const metaM = html.match(/<meta[^>]+content="([^"]+)"[^>]*r=['"]m['"]/);
  const metaContent = metaM ? metaM[1] : '';
  const metaId = (html.match(/<meta[^>]+id="([^"]+)"[^>]*r=['"]m['"]/) || [])[1] || '';
  const scriptM = html.match(/<script[^>]+src="([^"]+\.js)"[^>]*r=['"]m['"]/);
  const scriptSrc = scriptM ? scriptM[1] : '';

  // 触发函数: 所有内联 r='m' 脚本里的顶层函数调用
  const inlineTriggers = [];
  const triggerRe = /<script[^>]*r=['"]m['"][^>]*>\s*([A-Za-z_$][\w$]*)\(\)/gi;
  let tm;
  while ((tm = triggerRe.exec(html)) !== null) {
    inlineTriggers.push(tm[1]);
  }
  const hasLcdCall = /\$_ts\.lcd\s*\(\)/.test(html);

  log(`html=${html.length}b url=${pageUrl}`);
  log(`nsd=${nsd} cd=${cd.length}chars metaId=${metaId} scriptSrc=${scriptSrc}`);
  log(`inlineTriggers=[${inlineTriggers.join(',')}] lcdCall=${hasLcdCall}`);

  // ── 2. 取 VM 代码 ─────────────────────────────────────────
  let vmCode;
  if (vmPath && fs.existsSync(vmPath)) {
    vmCode = fs.readFileSync(vmPath, 'utf-8');
    log(`VM from file: ${vmPath} (${vmCode.length}b)`);
  } else {
    let vmUrl = scriptSrc;
    if (!vmUrl.startsWith('http')) {
      const base = pageUrl.replace(/\/[^/]*$/, '/');
      vmUrl = (vmUrl.startsWith('/') ? new URL(pageUrl).origin : base) + vmUrl;
    }
    log(`Fetching VM: ${vmUrl}`);
    const resp = await fetch(vmUrl, { headers: { 'User-Agent': UA, 'Referer': pageUrl } });
    if (!resp.ok) throw new Error(`VM fetch failed: ${resp.status}`);
    vmCode = await resp.text();
    log(`VM downloaded: ${vmCode.length}b`);
  }

  // ★ timer 追踪 (与 timers_sdenv.js 同款)
  const _stNative = globalThis.setTimeout, _siNative = globalThis.setInterval;
  let _tid = 0;
  globalThis.__t0 = Date.now();
  globalThis.setTimeout = function (fn, d, ...args) {
    const id = ++_tid;
    const fns = String(fn).split(String.fromCharCode(10))[0].slice(0, 40);
    log('[T] setTimeout #' + id + ' d=' + d + ' fn=' + fns);
    return _stNative(() => {
      log('[T-FIRE] #' + id + ' @' + ((Date.now() - globalThis.__t0) / 1000).toFixed(2) + 's');
      fn(...args);
    }, d);
  };
  globalThis.setInterval = function (fn, d) {
    const id = ++_tid;
    log(`[T] setInterval #${id} d=${d}`);
    // ★ 2026-09-01 实验: 节流补偿 fire — Node 阻塞后连续补 fire (间隔<d) 与 jsdom 不补偿差异
    //   (N 侧检测周期多一轮的假设根因)
    let _last = 0;
    return _siNative(() => {
      const _now = Date.now();
      if (_now - _last < d * 0.5) { log(`[T-INT-SKIP] #${id} @${((_now - globalThis.__t0) / 1000).toFixed(2)}s (throttle)`); return; }
      _last = _now;
      log(`[T-INT-FIRE] #${id} @${((_now - globalThis.__t0) / 1000).toFixed(2)}s`);
      fn();
    }, d);
  };
  // env.js 会用这些 (包装后的) timer 再包一层 try/catch — 保持顺序

  // ── 3. 干净沙箱 (vm.createContext) + 构建环境 ──────────────
  // ★ 关键: VM 通过 window.top/window.parent 等能看见的必须是干净 realm,
  //   不能暴露 Node 的 process/require/Buffer (jsdom 同构)
  const vmMod = require('vm');

  // ★ Error.stack 读取日志: VM 可能解析 stack 格式做环境检测
  try {
    const _stackDesc = Object.getOwnPropertyDescriptor(globalThis.Error.prototype, 'stack');
    Object.defineProperty(globalThis.Error.prototype, 'stack', {
      get() {
        const v = _stackDesc.get.call(this);
        try { log('[STACK] ' + String(v).slice(0, 200).replace(/\n/g, ' | ')); } catch (e) {}
        return v;
      },
      set(nv) { return _stackDesc.set ? _stackDesc.set.call(this, nv) : true; },
      configurable: true,
    });
  } catch (e) { log('[STACK] patch fail: ' + e.message); }
  // ★ jsdom 同构: createContext(DONT_CONTEXTIFY) — 上下文全局就是 window
  //   (真实 V8 global, 无 contextify 置顶重排; 裸赋值不动枚举顺序 — 实测验证)
  const ctx = vmMod.createContext(vmMod.constants.DONT_CONTEXTIFY);
  if (fixDate) {
    // 固定 epoch: 2026-08-16 08:00:00 UTC = 1786867200
    const _FD = new Date(1786867200000);
    ctx.Date = class extends Date {
      constructor(...args) { super(...(args.length ? args : [1786867200000])); }
      static now() { return 1786867200000; }
      static parse(...a) { return Date.parse(...a); }
      static UTC(...a) { return Date.UTC(...a); }
    };
    ctx.Date.prototype = Date.prototype;
    log('[FIXDATE] Date 固定为 1786867200000');
  }

  // ★ 不提前定义 _sdGlobalObject/_globalProxy — sdenv 实测轮1 遍历无此键,
  //   它们由 VM 自身在运行中定义 (轮2 末尾才出现, 插入序末尾) — 提前定义导致轮1 多 2 键 → 指纹分叉
  // jsdom 实测原型链 (2026-08-19):
  //   window → Window.prototype(own=0, forin=[]) → WindowProperties.prototype(own=0)
  //   → EventTarget.prototype(removeEventListener/dispatchEvent 可枚举!) → Object.prototype
  //   ★ for-in window = 229 键 (S trace): 自身 227 + 原型链 EventTarget.prototype 2 键!
  //   ★ getPrototypeOf(window) 的 for-in = [] — 原型链键必须放在更深的 EventTarget 层
  //   (2026-08-19 晚): V8 for-in 走完整原型链 — 原型链可枚举键排在自身键之后!
  //   S: 尾部 = ...,_$oz,$bf89a016$,removeEventListener,dispatchEvent (原型链键收尾)
  //   ★ window instanceof Window === true (jsdom) — VM 检测 L49: 'try{return (window instanceof Window);}catch(e){}'
  //     缺 Window 类 → instanceof 抛错 → catch → undefined vs true 分叉 (op 51 写入)
  {
    // L0: Window.prototype (own 可枚举 = 0, jsdom 实测)
    // ★★★ 2026-08-19 修复 (task 2/10/93/102/103/106/112/829/852/868/872/874 topE):
    //   链末端接回 Object.prototype — jsdom 链 = ... → EventTarget.prototype → Object.prototype;
    //   N 侧断在 null → String(window)/window.toString()/window.valueOf() 全抛 TypeError
    //   (G85 探针 topE 暴露, VM 自身同样会触发 → 真实分叉!)
    //   Object.prototype 无枚举键 → for-in 链不增键; toString/valueOf native 形态自动对齐 jsdom
    const windowProto = Object.create(null);
    Object.setPrototypeOf(windowProto, Object.prototype);
    // ★ 用 function 而非 class: class 的 prototype 不可配置 — instanceof 必须检查
    //   WindowCtor.prototype, 而 ctx 链上的 L0 是 windowProto → 两者必须同一对象!
    //   (2026-08-19: class 写法 → ctx instanceof Window = false → B() 返回 false/undefined 分叉)
    const WindowCtor = function Window() { throw new TypeError('Illegal constructor'); };
    Object.defineProperty(WindowCtor, 'prototype', { value: windowProto, writable: true, configurable: false, enumerable: false });
    Object.defineProperty(windowProto, 'constructor', { value: WindowCtor, writable: true, enumerable: false, configurable: true });
    Object.defineProperty(windowProto, Symbol.toStringTag, { value: 'Window', writable: false, enumerable: false, configurable: true });
    // L1: WindowProperties.prototype (own 可枚举 = 0)
    const winPropsProto = Object.create(windowProto);
    // L2: EventTarget.prototype — jsdom 实测 (probe_proto.js 2026-08-19):
    //   3 事件键在链第 3 级 (ppp) 且对 for-in 不可见 (jsdom 内部 Proxy 断链)
    //   ★ for-in Object.getPrototypeOf(window) = 0 (jsdom) — ARG30 探针分叉点!
    //   ★ for-in ctx 的 229 键由 ownKeys trap 提供 (含 removeEventListener/dispatchEvent 自身键,
    //     align_order 已排尾部) — 链上键若 enum:true → for-in ctx 多 2 键 → 231 分叉
    //   → 修复 (2026-08-19): enum:false — 链上不可见, 与 jsdom 断链效果一致
    // ★ 2026-08-19 晚修复 (V8 for-in 穿透实验实证):
    //   for-in 普通对象起点 → 在首个 Proxy 原型处短路 (ARG30 = 0 ✓)
    //   for-in Proxy 起点 → 穿透嵌套 Proxy → 原型链 enum 键可见 (for-in window 尾部 re/dis ✓)
    //   → jsdom 镜像链: ctx→WinProto(普通0)→[wppProxy断链]→EvtKeys(re/dis enum:true)→WinProps→Win.prototype
    const evtProto = Object.create(winPropsProto);
    // ★ 链上事件键实现: env.js 的 _evProto 设置被 wppProxy 断链挡住 (defineProperty=false) →
    //   这里必须提供可用实现; dispatchEvent 返回 true (jsdom 语义, VM 可能检查)
    const _evL = {};
    const evFn = function (type, cb) { try { (_evL[type] || (_evL[type] = [])).push(cb); } catch (e) {} };
    // ★★★ 2026-08-19 修复 (task 1559/1562): __natName + name — fakePTS 查表返回 jsdom 源码,
    //   name 对齐 jsdom 'removeEventListener' (推断名 'evFn' 进指纹数组 → FV_IN 明文分叉!)
    //   (env.js 的 _evProto 修复被 wppProxy defineProperty=false 挡住 — 只能在这里修)
    try { Object.defineProperty(evFn, '__natName', { value: 'removeEventListener', configurable: true }); } catch (e2) {}
    try { Object.defineProperty(evFn, 'name', { value: 'removeEventListener', configurable: true }); } catch (e2) {}
    const disFn = function (ev) {
      try {
        const type = ev && (ev.type !== undefined ? ev.type : String(ev));
        if (type && _evL[type]) for (const f of _evL[type].slice()) { try { f(ev); } catch (e) {} }
      } catch (e) {}
      return true;
    };
    try { Object.defineProperty(disFn, '__natName', { value: 'dispatchEvent', configurable: true }); } catch (e2) {}
    try { Object.defineProperty(disFn, 'name', { value: 'dispatchEvent', configurable: true }); } catch (e2) {}
    // L3: EventTarget.prototype 模拟 — remove/dispatch 原型链键 desc.enumerable=TRUE (jsdom 同款)
    //   ★ 但 for-in 不可见: jsdom window 是 Proxy, for-in 只走 ownKeys(自身键)+ 不采原型链枚举键;
    //     nodenv ctx 本体 for-in 会上原型链 → 必须 enum:false 才与 sdenv 267 键视图一致
    //     (desc 层面的 enum:true vs false 差异 VM 目前无检测点, 2026-08-19 WIN-FORIN 对比实证)
    const evtKeysProto = Object.create(winPropsProto);
    // ★★★ 2026-08-19 权威对齐: jsdom EventTarget.prototype 的 re/dis enum:TRUE —
    //   S 数组实证: 尾部 = ..., _$e9, removeEventListener, dispatchEvent, reload (location 区前)
    //   (S 收集器遍历 realm.win 代理 → 原型链 enum 键可见; jsdom EventTarget.prototype desc=true,true 实测)
    //   [旧] enum:false → N ctx for-in 缺尾部 2 键 → 数组 240 vs 242 分叉 → P 不同 → 400
    Object.defineProperty(evtKeysProto, 'removeEventListener', { value: evFn, writable: true, enumerable: true, configurable: true });
    Object.defineProperty(evtKeysProto, 'dispatchEvent', { value: disFn, writable: true, enumerable: true, configurable: true });
    // L2.5: windowPropertiesProxy 模拟 — jsdom: Proxy + immutable (defineProperty/setPrototypeOf 拒绝)
    //   ownKeys(无 trap→target)=[Symbol.toStringTag] 非空 → Proxy 起点穿透; 普通起点短路
    const winPropsTarget = Object.create(evtKeysProto, { [Symbol.toStringTag]: { value: 'WindowProperties', configurable: true } });
    const wppProxy = new Proxy(winPropsTarget, {
      getOwnPropertyDescriptor(t, p) { return Reflect.getOwnPropertyDescriptor(t, p); },
      has(t, p) { return Reflect.has(t, p); },
      get(t, p, r) { return Reflect.get(t, p, r); },
      set(t, p, v, r) { return Reflect.set(t, p, v, r); },
      defineProperty() { return false; },
      deleteProperty() { return false; },
      setPrototypeOf() { throw new TypeError('Immutable prototype object'); },
      preventExtensions() { return false; },
    });
    // L2: Window.prototype 模拟 — 普通对象, 原型 = 断链 Proxy
    Object.setPrototypeOf(evtProto, wppProxy);
    try { Object.setPrototypeOf(ctx, evtProto); } catch (e) { log('[PROTO] setPrototypeOf fail: ' + e.message); }
    // window.Window 类 — jsdom: enumerable:false (for-in 无但 get/ownKeys 可读)
    Object.defineProperty(ctx, 'Window', { value: WindowCtor, writable: true, configurable: true, enumerable: false });
    log('[PROTO] chain: ctx→EventTarget→WindowProperties→Window.prototype; Window class set');
  }
  // ★ window 代理: for-in 视图对齐 sdenv VM 内枚举实测:
  //   - 跳过 _ 前缀的 jsdom 内部键 (除 _currentEvent)
  //   - 跳过 window/self/top/frames 自引用
  //   - 其余按 SDENV_ORDER 顺序 (align_order.js)
  let SDENV_ORDER = [];
  try { SDENV_ORDER = require('./align_order.js').SDENV_ORDER; } catch (e) {}
  const SKIP_KEYS = new Set(['window', 'self', 'top', 'frames']);
  // ★★★ 2026-08-19 权威对齐 (sdenv 194908 轮 200 参照 WINALL 229 键):
  //   ownKeys 隐藏集 — sdenv-extend 三路隐藏 / jsdom 不可枚举, VM 所有枚举 API 不可见
  const HIDDEN_KEYS = new Set(['_sdGlobalObject', '_globalProxy', '$bf89a016$']);
  const JS_INTERNAL_UNDER = new Set([
    '_registeredHandlers', '_eventHandlers', '_resourceLoader', '_document', '_origin',
    '_sessionHistory', '_virtualConsole', '_runScripts', '_top', '_parent', '_frameElement',
    '_length', '_pretendToBeVisual', '_storageQuota', '_commonForOrigin', '_currentOriginData',
    '_localStorage', '_sessionStorage', '_selection', '_customElementRegistry',
  ]);
  // ★ 2026-08-19: _sdGlobalObject/_globalProxy 必须过滤 — sdenv-extend
  //   windowGetterUndefinedKeys 显式排除它们 (ownKeys/has/get 三路全隐藏),
  //   VM 运行期 for-in 无此二键; 此前放行 → 每轮 +2 任务 → 轮次错位 → 400
  const ALLOW_UNDER_KEYS = new Set();
  let f82OKC = 0;  // ★ F82 探针 for-in 是否走 winProxy ownKeys trap 的计数 (区分 winProxy vs ctx 本体)
  const winProxy = new Proxy(ctx, {
    ownKeys(t) {
      f82OKC++;
      try {
        // ★★★ 2026-08-19 权威对齐 (sdenv 194908 轮 200 参照):
        //   ownKeys 全放行 (jsdom 同款) — getOwnPropertyNames/Reflect.ownKeys 视图必须完整,
        //   ownKeys 过滤会让 VM 索引访问 undefined → 崩 (实测 11:19 三轮崩溃根因)!
        //   for-in 可见性由 enum:false 控制: 下划线 20 键/window/self/top/frames 在
        //   JS_INTERNAL_UNDER_KEYS 重定义处降枚举; sd 键同样 enum:false
        //   (jsdom 注入形态: enum:false own 键 → for-in 无, get/has 有 — 与 229 键参照一致)
        // ★ 2026-08-19 19:38 实测修正: sdenv (jsdom 200) for-in 尾部可见 $bf89a016$ (VM 主状态对象)!
        //   [旧] 从视图排除 + has/get 隐藏 → VM 读 undefined → 指纹分叉 → 400
        //   (注释曾称"S 侧 VM 独立 context 不进 jsdom window" — 19:38 探针实证错误)
        const all = Reflect.ownKeys(t);
        const numKeys = all.filter(k => typeof k === 'string' && /^(0|[1-9]\d*)$/.test(k));
        const strs = all.filter(k => typeof k === 'string' && !/^(0|[1-9]\d*)$/.test(k));
        const syms = all.filter(k => typeof k !== 'string');
        const sd = strs.filter(k => k === '_sdGlobalObject' || k === '_globalProxy');
        const rest = strs.filter(k => k !== '_sdGlobalObject' && k !== '_globalProxy');
        return [...numKeys, ...sd, ...rest, ...syms];
      } catch (e) {
        log('[TRAP-ERR] ' + e.message);
        return Reflect.ownKeys(t);
      }
    },
    set(t, p, v) {
      // ★ jsdom windowPropertiesProxy immutable: 原型链已有的事件键赋值失败 (own 键不创建)
      //   ESW 实测 jsdom window 全程无 own remove/dispatch — 键只在原型链 (enum:true, for-in 尾部)
      if (p === 'removeEventListener' || p === 'dispatchEvent') return true;
      // ★ 2026-08-19: $bf89a016$ 创建点追踪 (N 独有键, S 侧 VM 未创建 → 分支分叉)
      if (typeof p === 'string' && p.length > 4 && p.endsWith('$') && /^\$[0-9a-f]+$/.test(p)) {
        try { require('fs').appendFileSync('dollar_key_stack.txt', '\n/* set ' + p + ' */\n' + new Error().stack.slice(0, 1200) + '\n', 'utf-8'); } catch (e) {}
      }
      // ★ 2026-08-19 11:43: VM 挂载键追踪 (N 14 vs S 13 — 差 1 键 = 环境检测分叉!)
      if (typeof p === 'string' && (p === '$b_setup' || p === 't' || p === 'a' || /^_\$\$?/.test(p))) {
        try { require('fs').appendFileSync('vm_mount_keys.txt', '\n/* set ' + p + ' */\n' + new Error().stack.slice(0, 1500) + '\n', 'utf-8'); } catch (e) {}
      }
      const r = Reflect.set(t, p, v);
      if (r) reorderSdLast();
      return r;
    },
    defineProperty(t, p, d) {
      // ★ 同上: 拒绝创建 own 事件键 (jsdom defineProperty trap 返回 false)
      if (p === 'removeEventListener' || p === 'dispatchEvent') return false;
      // ★ $bf89a016$ 创建点追踪
      if (typeof p === 'string' && p.length > 4 && p.endsWith('$') && /^\$[0-9a-f]+$/.test(p)) {
        try { require('fs').appendFileSync('dollar_key_stack.txt', '\n/* defineProperty ' + p + ' */\n' + new Error().stack.slice(0, 1200) + '\n', 'utf-8'); } catch (e) {}
      }
      // ★ VM 挂载键追踪 (N 14 vs S 13)
      if (typeof p === 'string' && (p === '$b_setup' || p === 't' || p === 'a' || /^_\$\$?/.test(p))) {
        try { require('fs').appendFileSync('vm_mount_keys.txt', '\n/* defineProperty ' + p + ' */\n' + new Error().stack.slice(0, 1500) + '\n', 'utf-8'); } catch (e) {}
      }
      const r = Reflect.defineProperty(t, p, d);
      if (r) reorderSdLast();
      return r;
    },
    // ★ 2026-08-19 实测修正: VM 运行读取 _sdGlobalObject → undefined 即崩 (Cannot read '0')
    //   → sdenv jsdom 注入的 sd 键 get/has 可见 (值 = Window 自引用), 仅 ownKeys 枚举隐藏
    //   (jsdom 注入 enum:false + sdenv-extend ownKeys 过滤 → for-in/keys 无, get/has 有)
    has(t, p) {
      return Reflect.has(t, p);
    },
    get(t, p, r) {
      return Reflect.get(t, p, r);
    },
  });
  // ★ 2026-08-19: 重排逻辑废弃 — sdenv 运行期 for-in 无 _sdGlobalObject/_globalProxy
  //   (ownKeys 已过滤 + has/get 已隐藏), 删除重建会重新制造可枚举键 → 保持 no-op
  const reorderSdLast = () => {};
  // ★ 2026-08-19 权威对齐: _sdGlobalObject/_globalProxy 提前定义 (sdenv jsdomFromText 在 VM 前注入)
  //   值 = window 自引用 (probe3 实测 Window 引用), 读值可见 (VM 读 undefined 即崩)
  //   ★ enum:FALSE — jsdom 注入形态 (enum:false own 键) → for-in/keys 无 (与 229 键参照一致),
  //     ownKeys trap 前置到字符串段最前 (sdenv-extend ownKeys 过滤 → VM getOwnPropertyNames 无?
  //     ★ 实测: ownKeys 过滤 → 崩!→ 前置保持可见, enum:false 只影响 for-in/keys)
  try {
    Object.defineProperty(ctx, '_sdGlobalObject', { value: winProxy, writable: true, configurable: true, enumerable: false });
    Object.defineProperty(ctx, '_globalProxy', { value: winProxy, writable: true, configurable: true, enumerable: false });
  } catch (e) { log('[PROTO] sdGlobalObject define fail: ' + e.message); }
  // ★ globalThis 绑定 winProxy (jsdom: globalThis === window) — 否则 VM 里
  //   globalThis.removeEventListener = fn 绕过 traps 直接写 ctx → own 键分叉
  try { Object.defineProperty(ctx, 'globalThis', { value: winProxy, writable: false, configurable: true, enumerable: false }); } catch (e) { log('[PROTO] globalThis bind fail: ' + e.message); };
  // window/self/top/parent/frames 自引用 (jsdom 形态 — 指向代理)
  // ★ 2026-08-19 权威对齐: S 侧 200 参照 WINALL 有 parent, 无 window/self/top/frames
  //   → 后四者 enum:FALSE (sdenv-extend WinKeys get 返回 realm.win = 遍历对象 → 收集器自引用跳过;
  //     jsdom ownKeys 含它们但 for-in 值检查跳过) — parent 非自引用 (值=jsdom 本体) → enum:TRUE
  Object.defineProperty(ctx, 'window', { value: winProxy, writable: true, configurable: true, enumerable: false });
  Object.defineProperty(ctx, 'self', { value: winProxy, writable: true, configurable: true, enumerable: false });
  Object.defineProperty(ctx, 'top', { value: winProxy, writable: true, configurable: true, enumerable: false });
  Object.defineProperty(ctx, 'parent', { value: winProxy, writable: true, configurable: true, enumerable: true });
  Object.defineProperty(ctx, 'frames', { value: winProxy, writable: true, configurable: true, enumerable: false });
  // ★ 上下文内 eval/Function: 在 ctx realm 中执行 (不是外层 Node realm)
  // filename 用页面 URL: Error.stack 帧显示浏览器风格而非 evalmachine
  const SANDBOX_EVAL = vmMod.runInContext('eval', ctx);   // ★ 覆盖 ctx.eval 前抓取沙箱原生 eval
  const _rawEval = (code) => {
    // ★ 2026-08-19: 含 this.a=1 的 eval 代码全文落盘 (定位 'a' 创建源)
    if (typeof code === 'string' && code.includes('this.a=1')) {
      try {
        const _h = require('crypto').createHash('md5').update(code).digest('hex').slice(0, 8);
        require('fs').writeFileSync('eval_thisa1_' + code.length + '_' + _h + '.js', code, 'utf-8');
        process.stderr.write('[EVAL-thisa1] saved ' + code.length + 'b h=' + _h + '\n');
      } catch (e) {}
    }
    // ★ 短代码片段调用栈记录 (const l / Z8XHJJY 重复触发来源定位)
    if (typeof code === 'string' && (code.includes('Z8XHJJY') || /^(const|let|var) l=1;/.test(code))) {
      try {
        require('fs').appendFileSync('short_eval_stacks.txt',
          String.fromCharCode(10) + '/* ' + Date.now() + ' ' + code.slice(0, 40) + ' */' +
          String.fromCharCode(10) + String(new Error().stack).slice(0, 1500), 'utf-8');
      } catch (e2) {}
    }
    // ★ eval 完成值语义 (2026-08-19): IIFE 包裹无 return → 完成值丢失!
    //   task 1628 op61: !new function(){eval("this.sa=1")}().a
    //     N=undefined (IIFE 返回 undefined) vs S=true (原生 eval 完成值) → 分叉 → cookie 变 343
    //   修复: 沙箱原生 eval 间接调用 (call 指定 ctx 全局) — 与 sd_trace.js origEval.call(window) 同构:
    //     全局作用域执行 + 完成值返回 + let/const 不泄漏 (原生 eval 自带声明环境)
    // ★ 主 chunk 全量落盘 (2026-08-19): 定位 N 独有异常 (matches/appendChild/toString) 代码
    if (typeof code === 'string' && code.length >= 60 && !code.includes('JSON.stringify({op:')) {
      try {
        const _h = require('crypto').createHash('md5').update(code).digest('hex').slice(0, 8);
        require('fs').appendFileSync('all_eval.txt', String.fromCharCode(10) + '/* ' + code.length + 'b h=' + _h + ' */' + String.fromCharCode(10) + code + String.fromCharCode(10), 'utf-8');
      } catch (e) {}
    }
    // ★ 主 chunk 插桩 (2026-08-19): 特征向量函数 dump (对比 S 侧 FEAT 行定位块选择分叉)
    if (typeof code === 'string' && code.length >= 400000) {
      try {
        // ★ aebi/scj 函数体 dump (2026-08-19): task0 分叉 _$it vs _$a3 — 对比函数体判定是否有害
        try {
          const _tso = ctx['$_ts'];
          if (_tso) {
            const _ab = String(_tso.aebi);
            const _sc = String(_tso.scj);
            require('fs').writeFileSync('ts_aebi_scj.txt',
              'AEBI(' + _ab.length + '):\n' + _ab + '\n\nSCJ(' + _sc.length + '):\n' + _sc, 'utf-8');
          }
        } catch (e) {}
        const _ic = instrumentMainChunk(code, (m) => process.stderr.write(m + '\n'));
        if (_ic !== code) {
          code = _ic;
          try { require('fs').writeFileSync('main_chunk_instrumented_' + code.length + '.js', code, 'utf-8'); } catch (e) {}
        }
        const _bc = instrumentBoot(code, (m) => process.stderr.write(m + '\n'));
        if (_bc !== code) {
          code = _bc;
        }
        const _khc = instrumentKHCtor(code, (m) => process.stderr.write(m + '\n'));
        if (_khc !== code) {
          code = _khc;
        }
      } catch (e) { process.stderr.write('[MAIN-ERR] ' + e.message + '\n'); }
    }
    // ★★★ 2026-08-19 修复 (task 86): Error.stack filename 'eval ' vs 'https...'
    //   之前 SANDBOX_EVAL.call(ctx, code) → Node vm 默认 filename='evalmachine.<anonymous>'
    //   jsdom eval 的 filename = 页面 URL → VM 读 Error.stack 帧分叉
    //   改 vm.Script(filename=pageUrl) — 完成值/声明环境/this 语义与全局 eval 一致
    if (typeof code === 'string') {
      if (code.includes('this.a=1')) {
        try {
          process.stderr.write('[EVAL-THIS] this=' + (this === ctx ? 'CTX' : this === winProxy ? 'WINPROXY' : (typeof this) + ':' + String(this).slice(0, 50)) +
            ' code=' + code.slice(0, 40) + '\n');
        } catch (e) {}
      }
      try {
        // ★★★ 2026-08-19 (第三处) Error.stack filename 对齐 — S44 实证:
        //   S 侧主代码 = sdenv-jsdom vm.runInContext(filename=页面URL) 执行 (动态 script 注入)
        //   → 帧 "at _$i0 (https://...:2:95943)" 直接帧 (无 eval 包装)
        //   N 侧 SANDBOX_EVAL(原生 eval) → 帧 "at _$i0 (eval at _rawEval (C:\...run_vm.js:563)"
        //   → 泄漏宿主路径 → Error.stack 进指纹 → 400
        //   对齐: vm.Script + filename=页面URL → this=ctx (S 侧 this=window 同构, ctx=window 全局)
        //   完成值/声明环境/let 不泄漏 与 eval 一致; 主代码已由 instrumentMainChunk 插桩过
        if (traceTask || debug) {
          return new vmMod.Script(String(code), { filename: pageUrl || 'vm.js' }).runInContext(ctx);
        }
        return SANDBOX_EVAL.call(this, String(code));
      } catch (e) {
        if (String(e && e.message).includes('does not match the tag')) throw e; // 保留诊断
        return SANDBOX_EVAL.call(this, String(code));
      }
    }
    return SANDBOX_EVAL.call(this, String(code));
  };
  const ctxEval = function eval(...args) { return _rawEval.call(this, args[0]); };
  Object.defineProperty(ctxEval, 'name', { value: 'eval', configurable: true });
  Object.defineProperty(ctxEval, '__natName', { value: 'eval', configurable: true });
  // ★★★ 2026-08-19 直接 eval this 语义修复 (核心!):
  //   VM 代码 eval("this.a=1") 是语法级直接 eval → this = 调用者 this (new function(){eval(...)} → 新对象)
  //   v8 的 EvalSpecial 只在"解析到原生 eval"时生效 (deferred check) — 劫持为普通函数后
  //   this = undefined → global → ctx.a=1 泄漏全局键 'a' (S 侧无 → 指纹分叉 → 400)
  //   修复: accessor 返回沙箱原生 eval — VM 语法调用 → v8 识别原生 → 完整直接 eval 语义
  //   ★ env.js buildEnv 用 defineProperty 覆盖 eval (setGlobal) → 必须在 buildEnv 之后重装 (696 行)
  const installNativeEval = () => {
    if (traceTask || debug) return; // 调试模式保留插桩链
    try {
      // set 忽略: env.js 会把 eval 设成外层 realm eval (主 realm 无 $_ts → ReferenceError!)
      //   直接 eval 的语法特权 (this 继承) 只对原生 eval 生效 — 任何覆盖都会破坏 (2026-08-19 实测)
      Object.defineProperty(ctx, 'eval', {
        configurable: true,
        get() { return SANDBOX_EVAL; },
        set(v) { /* 忽略覆盖 — 保持沙箱原生 eval */ },
      });
    } catch (e) { ctx.eval = SANDBOX_EVAL; }
  };
  installNativeEval();
  // ★ 覆盖 ctx.Function 前抓取沙箱原生 Function 构造器 (B 函数用它构造 → anonymous 形态)
  const SANDBOX_FUNCTION = vmMod.runInContext('Function', ctx);
  const ctxFunctionImpl = function (args) {
    let body = String(args.pop() || '');
    const params = args.join(',');
    // ★ body 去重记录 (行号/列号对比用): 前 300 字符, 按 body 哈希去重
    if (traceTask && body.length <= 50000) {
      try {
        const _h = require('crypto').createHash('md5').update(body).digest('hex').slice(0, 8);
        require('fs').appendFileSync('fn_bodies.txt',
          '/* ' + body.length + 'b h=' + _h + ' */\n' + body.split('\n').slice(0, 8).join('\n') + '\n---\n', 'utf-8');
      } catch (e) {}
    }
    // ★ _$hp/_$d2 定位: 记录所有含这两个 token 的 chunk (无论大小)
    if (traceTask && (body.includes('_$hp') || body.includes('_$d2'))) {
      try {
        require('fs').appendFileSync('fn_hp.txt',
          String.fromCharCode(10) + '/* ==== HPCHUNK (' + body.length + 'b) params=' + params + ' ==== */' +
          String.fromCharCode(10) + body, 'utf-8');
        log('[FNHP] chunk with _$hp/_$d2: ' + body.length + 'b');
      } catch (e) {}
    }
    if (traceTask && body.length > 50000) {
      // 落盘所有大 Function 构造的代码 (含 cookie 组装 chunk)
      try {
        require('fs').appendFileSync('capture2.txt',
          String.fromCharCode(10) + '/* ==== FNCHUNK (' + body.length + 'b) ==== */' + String.fromCharCode(10) + body, 'utf-8');
        log('[FNCHUNK] captured ' + body.length + 'b');
      } catch (e) {}
      body = traceTaskExec(body, log);
    }
    // ★ B 用沙箱原生 Function 构造器构造 (覆盖 ctx.Function 前抓取的引用):
    //   V8 对 Function 构造产物统一 [[SourceText]] = 'function anonymous(params\n) {\nbody\n}'
    //   String(B) 直接读 [[SourceText]] → 与 jsdom window.Function 产物一致 ✓
    //   (runInContext 函数字面量是源码形态 → VM toString 指纹分叉 ✗)
    //   沙箱 Function 构造的 B 其作用域 = 沙箱全局 (ctx) → window/document 正常解析 ✓
    const fnArgs = (params ? params.split(',').map(s => s.trim()).filter(Boolean) : []).concat(body);
    return Reflect.construct(SANDBOX_FUNCTION, fnArgs);
  };
  // ★★★ Proxy 包装沙箱原生 %Function% (2026-08-19): 之前用主 realm 函数字面量做 wrapper →
  //   G88 探针 (task 594): N=function Function(...args){let body=...} vs S=function Function() { [native code] }
  //   → VM 指纹收集读 Function 字符串 → FV_IN 明文分叉 → 400!
  //   Proxy 方案: target=沙箱原生 Function → toString/name/prototype/__proto__/ownToString/length
  //   全部继承原生形态 (与 jsdom window.Function 完全一致), apply/construct trap 保留插桩逻辑 ✓
  const ctxFunction = new Proxy(SANDBOX_FUNCTION, {
    apply(t, thisArg, args) { return ctxFunctionImpl(args); },
    construct(t, args) { return ctxFunctionImpl(args); },
  });
  // ★ fakePTS 查表条件 (2026-08-19): proxy 不在 NATIVE_FNS/ENV_FNS → JS_TEXT['Function']
  //   查表不命中 → origPTS 对 proxy 返回匿名 native → G88 分叉 (task 594)
  //   __natName 命中条件分支 → 返回 JS_TEXT['Function'].text = 'function Function() { [native code] }' ✓
  //   (与 ctxEval 470 行先例一致 — eval 也带 __natName)
  Object.defineProperty(ctxFunction, '__natName', { value: 'Function', configurable: true });
  ctx.Function = ctxFunction;
  //   ★ 函数字面量 (_$_O) 由 ctx 原生 %Function% 构造 → .constructor 读 Function.prototype.constructor
  //     改指向 ctxFunction → G88 === 函数字面量 constructor, 与 jsdom 对齐;
  //     同时 Function.prototype.constructor===Function / x instanceof Function 在 ctx 内成立
  try { SANDBOX_FUNCTION.prototype.constructor = ctxFunction; } catch (e) {}
  // (ctxFunction 的 prototype/__proto__/name/toString/ownToString 全部继承 target — Proxy 无需修补)
  // scriptSrc 应为绝对 URL (jsdom 的 scriptEl.src 是解析后的绝对地址)
  const absScriptSrc = scriptSrc.startsWith('http') ? scriptSrc
    : new URL(scriptSrc, pageUrl).href;
  // 提取内联脚本源码 (VM 靠 script 元素的 innerText 找 config 块)
  const inlineScripts = [];
  const isRe = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let ism;
  while ((ism = isRe.exec(html)) !== null) {
    if (!/src=/.test(ism[1]) && ism[2].trim()) inlineScripts.push(ism[2].trim());
  }
  globalThis.__envLog = (m) => log(m);
  const { win, getCookie, log: envLog } = buildEnv({
    url: pageUrl, ua: UA, nsd, cd, metaId, metaContent, scriptSrc: absScriptSrc, debug,
    inlineScripts,
    win: winProxy,
    crypto: globalThis.crypto,
    // ★ 2026-09-01: cookie setter 过期判断基准对齐 VM 时间源 (fixdate 时 expires 为过去时间否则被删)
    fixDateMs: fixDate ? 1786867200000 : 0,
  });
  // ★★★ 沙箱 realm fakePTS (2026-08-19): VM 的 fn.toString / String(fn) 走 ctx %Function%
  //   主 realm 的 fakePTS 覆盖不到 → task 852 (open bound 匿名 vs jsdom 命名) 分叉
  //   必须在 buildEnv 之后 (installFakePTS 在 buildEnv 内定义), 且 SANDBOX_FUNCTION 已拿到
  try { require('./env.js').installFakePTS(SANDBOX_FUNCTION); } catch (e) { log('[FPT] sandbox install err: ' + e.message); }
  // ★ key 集合对齐 jsdom (for-in 扫描进指纹)
  require('./align_window.js').alignWindowKeys(win, ctx);
  // ★ document 键集对齐 sdenv (jsdom 实测 217 键) — VM 的 document 遍历 (15-44 第 3-4 轮) 依赖
  try {
    require('./align_document.js').alignDocumentKeys(win.document, win);
    log('[ALIGN-DOC] document keys -> ' + (() => { let n = 0; for (const k in win.document) n++; return n; })());
    try {
      const dk = []; for (const k in win.document) dk.push(k);
      const _sd = JSON.parse(require('fs').readFileSync('sdenv_doc_keys.json', 'utf-8'));
      const onlyN = dk.filter(k => !_sd.includes(k));
      const onlyS = _sd.filter(k => !dk.includes(k));
      log('[ALIGN-DOC] N only: ' + JSON.stringify(onlyN) + ' | S only: ' + JSON.stringify(onlyS));
    } catch (e) { log('[ALIGN-DOC] diff err: ' + e.message); }
  } catch (e) { log('[ALIGN-DOC] err: ' + e.message); }
  // ★★★ 2026-08-19 权威对齐 (S 段1 数组 240 键实证): _sdGlobalObject/_globalProxy
  //   不在 S 收集器数组 (sdenv-extend windowGetterUndefinedKeys 三路隐藏) → N 必须 enum:false
  //   [旧] SD-REENUM 强制 enum:true → N 数组头部 +2 键 → P 分叉 → 400 (已删除)
  // ★★★ PROBE_AUTH (2026-08-19): 认证清单值类型探测 — 与 sdenv 侧 _probe_auth_vals.js 对比
  if (process.env.PROBE_AUTH) {
    try {
      const _uniq = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'sdenv', 's_auth_reads.json'), 'utf-8')).uniq;
      const _out = [];
      for (const k of _uniq) {
        let type = 'ABSENT', own = false, proto = '';
        try {
          if (k in win) {
            type = typeof win[k];
            own = Object.prototype.hasOwnProperty.call(win, k);
            let p = win;
            while (p && !Object.prototype.hasOwnProperty.call(p, k)) p = Object.getPrototypeOf(p);
            proto = p && p !== win ? ((p.constructor && p.constructor.name) || 'anon') : 'self';
          }
        } catch (e) { type = 'THROW:' + String(e.message).slice(0, 30); }
        _out.push({ k, type, own, proto });
      }
      require('fs').writeFileSync(require('path').join(__dirname, '..', 'sdenv', 's_auth_vals_nodenv.json'), JSON.stringify(_out), 'utf-8');
      const _abs = _out.filter(x => x.type === 'ABSENT');
      log('[PROBE-AUTH] done ' + _out.length + ' ABSENT=' + _abs.length + ' ' + JSON.stringify(_abs.slice(0, 25).map(x => x.k)));
      process.exit(0);
    } catch (e) { log('[PROBE-AUTH] err: ' + e.message); process.exit(1); }
  }
  // ★★★ PROBE_FORIN (2026-08-19): 装配后 window for-in 键 — 与 sdenv_forin_keys.json 对比
  if (process.env.PROBE_FORIN) {
    try {
      const _fk = [];
      for (const k in win) _fk.push(k);
      require('fs').writeFileSync(require('path').join(__dirname, 'nodenv_forin_keys.json'), JSON.stringify(_fk), 'utf-8');
      log('[PROBE-FORIN] for-in=' + _fk.length + ' first10=' + JSON.stringify(_fk.slice(0, 10)) +
        ' last10=' + JSON.stringify(_fk.slice(-10)));
      process.exit(0);
    } catch (e) { log('[PROBE-FORIN] err: ' + e.message); process.exit(1); }
  }
  if (process.env.PROBE_WIN) {
    const _p1 = Object.getPrototypeOf(ctx);
    log('[PROBE-PROTO] ctxProtoWin=' + (_p1 && Object.getOwnPropertyDescriptor(_p1, Symbol.toStringTag) ? 'yes' : 'no') +
      ' evKeys=' + JSON.stringify(Object.keys(Object.getPrototypeOf(_p1)))) ;
  }
  if (process.env.PROBE_WIN) {
    log('[PROBE-PRE] keys=' + Object.keys(win).length +
      ' first10=' + JSON.stringify(Object.keys(win).slice(0, 10)) +
      ' tsIdx=' + Object.keys(win).indexOf('$_ts'));
    const fk = Object.keys(win).filter(k => { try { return typeof win[k] === 'function'; } catch (e) { return false; } }).slice(0, 8);
    log('[PROBE-PRE] firstFns=' + JSON.stringify(fk));
  }
  if (process.env.PROBE_TYPES) {
    try {
      const { SDENV_ORDER, SDENV_TYPES } = require('./align_order.js');
      const diffs = [];
      for (const k of SDENV_ORDER) {
        let t = '?';
        try { t = typeof win[k]; } catch (e) { t = 'err'; }
        if (t === 'undefined') { diffs.push(`${k}:undef(sdenv=${SDENV_TYPES[k] || 'fn'})`); continue; }
        if (SDENV_TYPES[k] === 'function' && t !== 'function') diffs.push(`${k}:${t}(sdenv=fn)`);
      }
      log('[PROBE-TYPES] mismatches: ' + (diffs.length ? diffs.slice(0, 25).join(', ') : 'none'));
    } catch (e) { log('[PROBE-TYPES] err: ' + e.message); }
  }
  // env.js 内部把 eval 设成了外层 eval (setGlobal defineProperty 覆盖) — 生产模式重装原生 accessor
  installNativeEval();
  //   调试模式: 保持 ctxEval 插桩链 (若 win === ctx 此处赋值会走 accessor setter → 跳过)
  if (traceTask || debug) { try { win.eval = ctxEval; } catch (e) {} }

  // ★★★ 以下诊断插桩仅 seqMode 启用 — 生产路径零陷阱 (与 sdenv 同构) ★★★
  const seqLog = [];
  const seqNote = (m) => seqLog.push(m);
  if (seqMode) {
  // ★ 首次 P-cookie 写入时 dump $_ts 全部内部状态 (与 sd_dump.js 同款, 供同轮 diff)
  (function () {
    // ★ 2026-09-01 根因修复: cookie 访问器在 docProto 原型 (env.js 943), 实例无自有键
    //   getOwnPropertyDescriptor 返回 undefined → desc.set.call 抛 TypeError → VM 写 cookie 被阻断 → 0c!
    //   S 侧 sd_trace_fix.js 有原型 fallback 所以正常 — 这里同步修复
    const desc = Object.getOwnPropertyDescriptor(win.document, 'cookie') ||
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(win.document), 'cookie');
    let done = false;
    Object.defineProperty(win.document, 'cookie', {
      get() { return desc.get.call(win.document); },
      set(v) {
        desc.set.call(win.document, v);
        const sv = String(v);
        if (sv.includes('=') && sv.split('=')[0].trim().endsWith('P')) {
          log(`[CKWRITE] ${sv.length}c FULL=${sv}`);
          // ★ cookie 写入瞬间 dump $_ts.cp 全值 (VM 直接写数组, 不触发 setter — 这里最准确)
          try {
            // ★ for-in 全键 dump (VM 收集器同款视图, 对比 S 侧 40 vs 33 差异)
            const fink = [];
            for (const kk in win) fink.push(kk);
            log('[FINK] count=' + fink.length + ' | ' + fink.join(','));
          } catch (e5) { log('[FINK] err: ' + e5.message); }
          try {
            const _ts = win['$_ts'];
            if (_ts && _ts.cp) {
              log('[CP@CKWRITE] len=' + _ts.cp.length + ' | ' +
                _ts.cp.map((x, i) => i + '=' + String(x).slice(0, 30)).join(' | '));
            } else {
              log('[CP@CKWRITE] _ts.cp missing');
            }
          } catch (e4) { log('[CP@CKWRITE] err: ' + e4.message); }
          try {
            const ol = ctx.__oplog || [];
            log(`[CKWRITE] oplog tail (${ol.length} 条):`);
            ol.slice(-25).forEach(l => log('  | ' + String(l).substring(0, 200)));
          } catch (e3) { log('[CKWRITE] oplog err: ' + e3.message); }
        }
        if (!done && String(v).includes('=') &&
            String(v).split('=')[0].trim().endsWith('P')) {
          done = true;
          try {
            const full = JSON.stringify(globalThis.__tsCaptured, (k, val) =>
              Array.isArray(val) && val.length > 2000
                ? { __trunc: val.length, head: val.slice(0, 2000) } : val);
            require('fs').writeFileSync('ts_at_cookie_node.json', full, 'utf-8');
            log('[TS@COOKIE] ts_at_cookie_node.json (' + full.length + 'b)');
            // ★ 全量 $_ts 对象 (含 VM 挂载的内部状态)
            const cur = win['$_ts'];
            const full2 = JSON.stringify(cur || {}, (k, val) => {
              if (Array.isArray(val) && val.length > 3000)
                return { __trunc: val.length, head: val.slice(0, 3000) };
              if (typeof val === 'function') return 'fn:' + String(val).slice(0, 60);
              return val;
            });
            require('fs').writeFileSync('ts_full_node.json', full2, 'utf-8');
            log('[TS-FULL] ts_full_node.json (' + full2.length + 'b)');
          } catch (e2) { log('[TS@COOKIE] err: ' + e2.message); }
        }
      },
      configurable: true,
    });
  })();

  // ★ 全序列窗口观测 (与 _seq_sdenv.js 同款, 供 diff)
  (function () {
    const watchKeys = ['navigator','screen','document','location','history','performance','crypto',
      'chrome','name','innerWidth','innerHeight','outerWidth','outerHeight','devicePixelRatio',
      'screenX','screenY','screenLeft','screenTop','localStorage','sessionStorage','top','self',
      'parent','frames','length','frameElement','matchMedia','getComputedStyle','MutationObserver',
      'XMLHttpRequest','fetch','Event','Image','WebSocket','indexedDB','AudioContext',
      'RTCPeerConnection','Worker','Function','eval','atob','btoa','Date','Math','JSON'];
    for (const k of watchKeys) {
      try {
        const desc = Object.getOwnPropertyDescriptor(win, k);
        if (!desc) continue;
        if ('value' in desc) {
          let v = desc.value;
          Object.defineProperty(win, k, {
            get() { try { seqNote('W:' + k + '=' + String(v).slice(0, 22)); } catch (e) { seqNote('W:' + k + '=<?>'); } return v; },
            set(nv) { seqNote('W:' + k + '<=SET'); v = nv; },
            configurable: true, enumerable: desc.enumerable,
          });
        } else if (desc.get) {
          const g = desc.get;
          Object.defineProperty(win, k, {
            get() { seqNote('W:' + k); return g.call(win); },
            configurable: true, enumerable: desc.enumerable,
          });
        }
      } catch (e) {}
    }
    const d = win.document;
    for (const key of ['getElementById','getElementsByTagName','querySelector','querySelectorAll','createElement']) {
      const orig = d[key];
      d[key] = function (...args) {
        const r = orig.apply(this, args);
        seqNote('D:' + key + '(' + String(args[0]).slice(0, 20) + ')→' + (r === null ? 'null' : Array.isArray(r) ? 'arr' + r.length : (r && r.length !== undefined ? 'coll' + r.length : 'obj')));
        return r;
      };
    }
  })();

  // ★ $_ts 属性写入 hook (与 ts_trace_sdenv.js 同款) + 值捕获
  let _tswSeq = 0;
  const cptrapped = new WeakSet();
  globalThis.__tsCaptured = {};
  const hookTsWrites = () => {
    const ts = win['$_ts'];
    if (!ts || ts.__hooked) return;
    ts.__hooked = true;
    for (const k of ['nsd', 'cd', 'scj', 'aebi', 'cp', 'jf', 'lcd']) {
      let v = ts[k];
      Object.defineProperty(ts, k, {
        get() { return v; },
        set(nv) {
          _tswSeq++;
          log(`[TSW] #${_tswSeq} ${k} = ${Array.isArray(nv) ? 'arr[' + nv.length + ']' : String(nv).slice(0, 30)}`);
          if (k === 'cp') {
            log('[TSW-CP] stack: ' + String(new Error().stack).split('\n').slice(1, 6).join(' < '));
            log('[TSW-CP] cp ownKeys: ' + JSON.stringify(Object.keys(nv)));
            try { log('[CP-FULL] ' + nv.map((x, i) => i + '=' + String(x).slice(0, 40)).join(' | ')); } catch (e) {}
          }
          // ★ Proxy 记录 cp 读取/写入 (不撑 length, 记录编码是否读 cp[5]) — NO_CP_PROXY=1 关闭
          if (k === 'cp' && Array.isArray(nv) && !cptrapped.has(nv) && !process.env.NO_CP_PROXY) {
            const raw = nv;
            const prox = new Proxy(raw, {
              get(t, p, r) {
                if (typeof p === 'string' && /^\d+$/.test(p)) log(`[CP-GET] cp[${p}] = ${String(Reflect.get(t, p)).slice(0, 30)}`);
                return Reflect.get(t, p, r);
              },
              set(t, p, x, r) {
                if (typeof p === 'string' && /^\d+$/.test(p)) log(`[CP-SET] cp[${p}] = ${String(x).slice(0, 30)}`);
                return Reflect.set(t, p, x, r);
              },
              defineProperty(t, p, d) {
                if (typeof p === 'string' && /^\d+$/.test(p)) log(`[CP-DEF] cp[${p}] = ${String(d.value).slice(0, 30)}`);
                return Reflect.defineProperty(t, p, d);
              },
            });
            cptrapped.add(raw);
            nv = prox;
            log('[CP-TRAP] proxy installed');
          }
          globalThis.__tsCaptured[k] = nv;
          v = nv;
        },
        configurable: true,
      });
    }
  };
  hookTsWrites();
  // $_ts 可能被重置为新对象 — 重置后重新 hook
  const _origTsDesc = Object.getOwnPropertyDescriptor(win, '$_ts');
  Object.defineProperty(win, '$_ts', {
    get() { return _origTsDesc.value; },
    set(nv) { log('[TSW] $_ts replaced'); _origTsDesc.value = nv; hookTsWrites(); },
    configurable: true,
  });
  } // end if (seqMode)

  // ★ eval 捕获 (对比 sdenv 生成代码) — 包上下文 eval

  // ★ eval 捕获 (对比 sdenv 生成代码) — 包上下文 eval
  const evalCaps = [];
  const _origEval = ctxEval;
  if (traceTask) {
    // ★ 追踪数组必须可枚举 (2026-08-19 修复): S 侧 sd_trace_fix.js:129-132 直接赋值
    //   (window.__taskLog = []) → 可枚举 → VM 6-30 for-in 收集器可见 (S trace n=336-339)
    //   此前错误地设为不可枚举 → N 侧 for-in 少 4 键 → 6-30 段少 4 次迭代 → 段序列 pos344 分叉 → 400
    Object.defineProperty(ctx, '__taskLog', { value: [], writable: true, configurable: true, enumerable: true });
    Object.defineProperty(ctx, '__evlog', { value: [], writable: true, configurable: true, enumerable: true });
    Object.defineProperty(ctx, '__oplog', { value: [], writable: true, configurable: true, enumerable: true });
    // ★ 2026-08-31: op27 独立日志 (oplog 200万上限截断尾部 — 用独立数组; enumerable:false 不进 for-in)
    Object.defineProperty(ctx, '__o27', { value: [], writable: true, configurable: true, enumerable: false });
    // ★ 2026-09-01: 段字节码 dump (任务表对比)
    Object.defineProperty(ctx, '__segdump', { value: [], writable: true, configurable: true, enumerable: false });
    // ★ 2026-09-01: G71 dump (T_T 数字表对比)
    Object.defineProperty(ctx, '__g71d', { value: [], writable: true, configurable: true, enumerable: false });
    Object.defineProperty(ctx, '__f82dump', { value: [], writable: true, configurable: true, enumerable: true });
    // ★ __exnLog 必须不可枚举: 可枚举会被 VM 原型遍历捕获 → 多一个 __exnLog 元素 → 多一次 dispatchEvent → P 值不同 → 400
    //   sdenv 无此键 (注入代码用 typeof 检查, 找不到就跳过异常记录)
    Object.defineProperty(ctx, '__exnLog', { value: [], writable: true, configurable: true, enumerable: false });
    // __tvals 只做数据通道, 不进枚举 (sdenv 无此键)
    Object.defineProperty(ctx, '__tvals', { value: [], writable: true, configurable: true, enumerable: false });
    // ★ sdenv 实测: 追踪数组排在 $_ts 之前 (beforeParse 先建, VM 后建 $_ts)
    //   align 重建把 $_ts 放到了位置 247 — 挪到追踪数组之后
    try {
      const _tsv = ctx['$_ts'];
      delete ctx['$_ts'];
      ctx['$_ts'] = _tsv;
    } catch (e) {}
  }
  setGlobal2Eval(win, _origEval, evalCaps, log, debug, traceTask);

  // ── 4. 按真实页面顺序执行脚本: 内联 → 外部VM → 内联触发 ─────
  // 解析出脚本序列 (保持出现顺序)
  const scriptItems = [];
  const scriptRe = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let sm;
  while ((sm = scriptRe.exec(html)) !== null) {
    const attrs = sm[1] || '';
    const body = sm[2] || '';
    if (/src=/.test(attrs)) {
      scriptItems.push({ type: 'external' });
    } else if (body.trim()) {
      scriptItems.push({ type: 'inline', body: body.trim() });
    }
  }

  let vmEvaled = false;
  for (const item of scriptItems) {
    if (item.type === 'external') {
      if (vmEvaled) continue;
      log('Eval external VM...');
      try { log('[PRE-VM] $_ts=' + (typeof ctx['$_ts']) + (ctx['$_ts'] ? ' nsd=' + ctx['$_ts'].nsd + ' cdL=' + String(ctx['$_ts'].cd || '').length : '')); } catch (e) {}
      try {
        if (cp4Fix !== null && vmCode.includes('_$aH[4]=_$mf(33)-_$cb;')) {
          vmCode = vmCode.replace('_$aH[4]=_$mf(33)-_$cb;', '_$aH[4]=' + cp4Fix + ';');
          log('[EVAL] cp4 fixed to ' + cp4Fix);
        }
        if (debug) {
          // ★ cp[4] 赋值点插桩: cp[4] = _$mf(33) - _$cb (op7) — 记录两个操作数
          if (vmCode.includes('_$aH[4]=_$mf(33)-_$cb;')) {
            vmCode = vmCode.replace('_$aH[4]=_$mf(33)-_$cb;',
              '_$aH[4]=function(){var _x=_$mf(33);try{__dbg("CP4F:x="+_x+" cb="+_$cb+" cl="+_$cl+" kr="+_$kr+" DD="+_$_D+" bG="+_$bG+" pH="+String(_$pH).slice(0,60));}catch(e){}return _x-_$cb;}();');
            log('[EVAL] cp4 instrumented');
          }
          // ★ codegen 解释器插桩: while(1){X=TAB[I++];if(X<96){
          const cgRe = /(while\(1\)\{)(_\$\w+)=(_\$\w+)\[(_\$\w+)\+\+\];if\((_\$\w+)<96\)\{/;
          if (cgRe.test(vmCode)) {
            vmCode = vmCode.replace(cgRe, function (m, head, opv, arrv, idxv) {
              return head + 'try{__dbg("CG:"+__dbgIdx+++" op="+' + arrv + '[' + idxv + '])}catch(e){};' +
                opv + '=' + arrv + '[' + idxv + '++];if(' + opv + '<96){';
            });
            log('[EVAL] codegen loop instrumented');
          }
          // ★ CG2 流插桩 (phase-2 字符串解析器): while(1){X=STR[I++];if(X<74){
          const cg2Re = /(while\(1\)\{)(_\$\w+)=(_\$\w+)\[(_\$\w+)\+\+\];if\((_\$\w+)<74\)\{/;
          if (cg2Re.test(vmCode)) {
            vmCode = vmCode.replace(cg2Re, function (m, head, opv, arrv, idxv) {
              return head + 'try{__dbg("CG2:"+__dbgIdx+++" op="+' + arrv + '[' + idxv + '])}catch(e){};' +
                opv + '=' + arrv + '[' + idxv + '++];if(' + opv + '<74){';
            });
            log('[EVAL] cg2 loop instrumented');
          }
        }
        // ★ 确定性 Math.random (2026-08-19): executor 洗牌随机化主 chunk, 两侧不同种子 → 主 chunk 版本不同 → 块选择分叉!
        //   注入 LCG 同种子, 使 N/S 生成同一主 chunk 版本, 同 chunk 对比才有效
        try {
          vmMod.runInContext(
            '(function(){var __seed=20260819;var __rcnt=0;window.__randlog=[];Math.random=function(){__seed=(__seed*1103515245+12345)>>>0;__rcnt++;try{window.__randlog.push(__rcnt+":"+(typeof window.__curtask!=="undefined"?window.__curtask:"?")+":"+((new Error().stack)||"").split("\\n").slice(2,4).join("|").slice(0,150));}catch(__e2r){}return (__seed/4294967296)%1;};Object.defineProperty(window,"__randcnt",{get:function(){return __rcnt;},enumerable:false});})();',
            ctx);
        } catch (e) { process.stderr.write('[RND-FIX] err: ' + e.message + '\n'); }
        vmMod.runInContext(vmCode, ctx, { filename: absScriptSrc || 'vm.js' });
        vmEvaled = true;
        log('VM loaded');
        // ★ 2026-08-19: $bf89a016$ 首次出现时刻追踪 (N 独有键, S 侧同 VM 不创建 → 分支分叉)
        if (!process.env.NO_DOLLAR_POLL) {
          const _t0d = Date.now();
          let _reported = false;
          const _dpoll = setInterval(() => {
            try {
              if (!_reported && Object.prototype.hasOwnProperty.call(ctx, '$bf89a016$')) {
                _reported = true;
                const _tn = ctx.__taskNo !== undefined ? ctx.__taskNo : '?';
                log('[DOLLAR] $bf89a016$ created @+' + ((Date.now() - _t0d) / 1000).toFixed(2) + 's taskNo=' + _tn +
                  ' val=' + String(ctx['$bf89a016$']).slice(0, 80) +
                  ' typeof=' + typeof ctx['$bf89a016$']);
                clearInterval(_dpoll);
              }
            } catch (e) {}
          }, 100);
        }
        if (process.env.PROBE_AFTER) {
          try {
            const fi = [];
            for (const k in ctx) fi.push(k);
            const d = ctx.document;
            const dk = [];
            if (d) { for (const k in d) dk.push(k); }
            log('[PROBE-AFTER] ctxForIn=' + fi.length +
              ' sd@' + fi.indexOf('_sdGlobalObject') + '/' + fi.indexOf('_globalProxy') +
              ' document@' + fi.indexOf('document') +
              ' docKeys=' + dk.length +
              ' docHead=' + JSON.stringify(dk.slice(0, 5)) +
              ' nodeType=' + (d ? d.nodeType : 'NONE') +
              ' docEl=' + (d && d.documentElement ? 'yes' : 'no') +
              ' instDoc=' + (d && ctx.Document ? (d instanceof ctx.Document) : 'noDocumentCtor') +
              ' protoTag=' + (d ? Object.prototype.toString.call(d) : 'NONE'));
          } catch (e) { log('[PROBE-AFTER] err: ' + e.message); }
        }
        // ★ chunk 全局数组枚举 (定位执行器外部表)
        if (traceTask) {
          try {
            const globs = vmMod.runInContext(
              'JSON.stringify(Object.keys(this).filter(function(k){return k.charAt(0)==="_";}).map(function(k){' +
              'var v=this[k];var t=typeof v;var s="";' +
              'try{if(v&&v.slice&&t!=="string")s="["+v.length+"] head="+JSON.stringify(v.slice(0,6));' +
              'else s=String(v);}catch(e){s="?";}' +
              'return k+":"+t+":"+s.slice(0,60);}))', ctx);
            log('[GLOB] ' + globs.slice(0, 600));
            require('fs').writeFileSync('glob_dump.json', globs, 'utf-8');
          } catch (e) { log('[GLOB] err: ' + e.message); }
        }
        // ★ 检查 codegen 后的 $_ts 结构 + 完整 dump 解码产物
        if (seqMode) {
        try {
          const tsSnap = vmMod.runInContext(
            "JSON.stringify(Object.keys($_ts||{}).map(function(k){var v=$_ts[k];" +
            "return k+':'+(Array.isArray(v)?('arr['+v.length+']0='+String(v[0]||'').slice(0,20)):String(v).slice(0,40));}))",
            ctx);
          log('[TS] ' + tsSnap);
          const dump = vmMod.runInContext(
            "JSON.stringify({scj: $_ts.scj, aebi: $_ts.aebi, cp: $_ts.cp})", ctx);
          require('fs').writeFileSync('ts_dump.json', dump, 'utf-8');
          log('[TS-DUMP] saved ts_dump.json (' + dump.length + 'b)');
        } catch (e) { log('[TS] err: ' + e.message); }
        }
        const funcs = Object.getOwnPropertyNames(win).filter(k => k.startsWith('_$') && typeof win[k] === 'function');
        log(`Global _$ funcs (${funcs.length}): ${funcs.slice(0, 25).join(', ')}`);
        if (process.env.PROBE_WIN) {
          try {
            const ks = vmMod.runInContext(
              "JSON.stringify(Object.keys(this).filter(function(k){try{return typeof this[k]==='function';}catch(e){return false;}}).slice(0,15))",
              ctx);
            log('[PROBE-WIN] 首个函数键: ' + ks);
            const all = vmMod.runInContext('Object.keys(this).length', ctx);
            const tsIdx = vmMod.runInContext('Object.keys(this).indexOf("$_ts")', ctx);
            log('[PROBE-WIN] window keys=' + all + ' $_ts@' + tsIdx);
          } catch (e) { log('[PROBE-WIN] err: ' + e.message); }
        }
      } catch (e) {
        log('VM error: ' + e.message);
        log((e.stack || '').split('\n').slice(0, 4).join('\n'));
        process.exit(1);
      }
      continue;
    }
    // 内联脚本: 按真实顺序执行 (config 块 → VM 前; 触发块 → VM 后)
    const label = item.body.slice(0, 40).replace(/\s+/g, ' ');
    log(`Eval inline: ${label}...`);
    // ★ contextify 语义差异: 裸赋值 `$_ts=window['$_ts']` 会把键挪到枚举 0 位
    //   (jsdom/sdenv 里位置不变 247) — 改写成属性写, 语义等价位置不动
    const inlineBody = item.body.replace(/^\s*\$_ts\s*=/, "window['$_ts']=");
    try {
      vmMod.runInContext(inlineBody, ctx, { filename: pageUrl });
    } catch (e) {
      log(`Inline eval error: ${e.message}`);
      log((e.stack || '').split('\n').slice(0, 6).join('\n'));
    }
    if (process.env.PROBE_WIN) {
      try {
        const info = vmMod.runInContext(
          'JSON.stringify({n:Object.keys(this).length, ts:Object.keys(this).indexOf("$_ts")})', ctx);
        log('[PROBE-STEP] ' + label.slice(0, 30) + ' → ' + info);
      } catch (e2) {}
    }
  }

  // ★ 派发 load 事件 (jsdom 在解析完成后触发; sdenv 的 load 回调延迟机制
  //   驱动瑞数第二阶段 — 这是 mine 缺失的关键一环)
  try { win.dispatchLoad(); log('load dispatched'); } catch (e) { log('load err: ' + e.message); }

  // 兜底: 如果页面没有显式触发块 (或触发失败), 尝试常见触发
  const tried = new Set();
  function tryCall(name) {
    if (tried.has(name)) return false;
    tried.add(name);
    const fn = win[name];
    if (typeof fn === 'function') {
      log(`Trigger: ${name}()`);
      try { fn(); return true; } catch (e) {
        log(`Trigger ${name} error: ${e.message}`);
        log((e.stack || '').split('\n').slice(0, 10).join('\n'));
      }
    }
    return false;
  }
  if (hasLcdCall) {
    const lcd = win['$_ts'] && win['$_ts'].lcd;
    if (typeof lcd === 'function') {
      log('Trigger: $_ts.lcd()');
      try { lcd(); } catch (e) { log('lcd error: ' + e.message); }
    }
  }
  for (const name of ['_$cl', '_$mW', '_$cd', '_$_8', '_$cK', '_$b2', '_$nV', '_$cn',
    '_$nB', '_$eH', '_$$k', '_$_s', '_$ic', '_$ln', '_$aP']) {
    tryCall(name);
  }

  // ── 6. 轮询 cookie ────────────────────────────────────────
  log(`Waiting up to ${waitSec}s for cookie...`);
  const t0 = Date.now();
  let lastLen = 0, stableCount = 0;

  function finish(ck) {
    try { require('fs').writeFileSync('seq_mine.txt', seqLog.join('\n'), 'utf-8'); } catch (e) {}
    if (traceTask) {
      try {
        const ol = ctx.__oplog || [];
        try {
          const rq = vmMod.runInContext('typeof Request==="undefined"?"undefined":String(Request).slice(0,60)+"|writable:"+Object.getOwnPropertyDescriptor(this,"Request")?.writable', ctx);
          log('[REQUEST-CHECK] ' + rq);
        } catch (e) {}
        require('fs').writeFileSync('oplog.json', JSON.stringify(ol), 'utf-8');
        log('[TRACE-TASK] saved oplog.json (' + ol.length + ')');
        const tv = ctx.__tvals || [];
        require('fs').writeFileSync('tvals.json', JSON.stringify(tv), 'utf-8');
        log('[TRACE-TASK] saved tvals.json (' + tv.length + ')');
      } catch (e) {}
      try {
        const el = ctx.__evlog || [];
        require('fs').writeFileSync('evlog.json', JSON.stringify(el), 'utf-8');
        log('[TRACE-TASK] saved evlog.json (' + el.length + ')');
      } catch (e) {}
      try {
        const tl = ctx.__taskLog || [];
        require('fs').writeFileSync('task_trace.json', JSON.stringify(tl), 'utf-8');
        log(`[TRACE-TASK] saved task_trace.json (${tl.length} invocations)`);
      } catch (e) {}
      try {
        const fd = ctx.__f82dump || [];
        require('fs').writeFileSync('f82dump.json', JSON.stringify(fd), 'utf-8');
        log(`[TRACE-TASK] saved f82dump.json (${fd.length} dumps) ownKeysTrapCalls=${f82OKC}`);
      } catch (e) {}
      try {
        const o27 = ctx.__o27 || [];
        require('fs').writeFileSync('o27log.json', JSON.stringify(o27), 'utf-8');
      } catch (e) {}
      try {
        const sgd = ctx.__segdump || [];
        require('fs').writeFileSync('segdump.json', JSON.stringify(sgd), 'utf-8');
        log(`[TRACE-TASK] saved segdump.json (${sgd.length})`);
      } catch (e) {}
      try {
        const g71 = ctx.__g71d || [];
        require('fs').writeFileSync('g71dump.json', JSON.stringify(g71), 'utf-8');
        log(`[TRACE-TASK] saved g71dump.json (${g71.length})`);
      } catch (e) {}
      try {
        const exl = ctx.__exnLog || [];
        require('fs').writeFileSync('exnlog.json', JSON.stringify(exl), 'utf-8');
        log(`[TRACE-TASK] saved exnlog.json (${exl.length} exceptions)`);
      } catch (e) {}
    }
    log(`RESULT: ${ck.length} chars @${((Date.now() - t0) / 1000).toFixed(1)}s`);
    // ★ window for-in 键序列 (task 347-350 收集器 KEY 对比用)
    try {
      const _wfi = [];
      for (const _k in ctx.window) _wfi.push(_k);
      log('[WIN-FORIN] ' + _wfi.length + ' tail40=' + JSON.stringify(_wfi.slice(-40)));
      try { require('fs').writeFileSync('win_forin_keys.json', JSON.stringify(_wfi), 'utf-8'); } catch (e) {}
      const _ri = _wfi.indexOf('removeEventListener');
      const _di = _wfi.indexOf('dispatchEvent');
      log('[WIN-FORIN] removeEventListener@' + _ri + ' dispatchEvent@' + _di);
      try {
        const _aD = Object.getOwnPropertyDescriptor(ctx, 'a');
        const _tD = Object.getOwnPropertyDescriptor(ctx, 't');
        log('[PROBE-a] a=' + (typeof ctx.a) + ' desc=' + JSON.stringify(_aD ? { w: _aD.writable, c: _aD.configurable, e: _aD.enumerable } : null)
          + ' | t=' + (typeof ctx.t) + ' desc=' + JSON.stringify(_tD ? { w: _tD.writable, c: _tD.configurable, e: _tD.enumerable } : null)
          + ' | a-str=' + String(ctx.a).slice(0, 80));
      } catch (e) { log('[PROBE-a] err ' + e.message); }
    } catch (e) { log('[WIN-FORIN] err: ' + e.message); }
    try {
      log('[PROBE-RND] ctx.Date.now=' + vmMod.runInContext('Date.now()', ctx) +
        ' ctx.Math.random=' + vmMod.runInContext('Math.random()', ctx) +
        ' ctx.randcnt=' + vmMod.runInContext('typeof window.__randcnt!=="undefined"?window.__randcnt:"na"', ctx) +
        ' ctx.newDate=' + vmMod.runInContext('new Date().getTime()', ctx));
      try {
        const rl = vmMod.runInContext('typeof window.__randlog!=="undefined"?window.__randlog:[]', ctx);
        require('fs').writeFileSync('randlog_node.json', JSON.stringify(rl), 'utf-8');
        log('[RANDLOG] randlog_node.json (' + (Array.isArray(rl) ? rl.length : 'na') + ' entries)');
      } catch (e2) { log('[RANDLOG] err: ' + e2.message); }
    } catch (e) { log('[PROBE-RND] err: ' + e.message); }
    // ★ 2026-08-31 ActiveXObject 探针 (15-31 任务 new undefined 根因)
    try {
      const _axo = vmMod.runInContext('typeof window.ActiveXObject', ctx);
      const _axv = vmMod.runInContext('String(window.ActiveXObject).slice(0,80)', ctx);
      log('[PROBE-AXO] win.ActiveXObject typeof=' + _axo + ' v=' + _axv);
    } catch (e) { log('[PROBE-AXO] err: ' + e.message); }
    // ★ 2026-08-31: window undefined 键 dump (202-249 收集器 undefined.toString ×3 根因)
    try {
      const _und = [];
      for (const _k in ctx.window) {
        try {
          const _v = ctx.window[_k];
          if (_v === undefined) _und.push(_k);
        } catch (e) {}
      }
      log('[PROBE-UNDEF] window undefined 键: ' + JSON.stringify(_und));
    } catch (e) { log('[PROBE-UNDEF] err: ' + e.message); }
    // ★ origin 探针: Task 1335 检查 [o].origin — N 侧是函数 vs S 侧字符串 URL
    try {
      const _ok = [];
      for (const _k in ctx.window) {
        if (String(_k).toLowerCase().includes('origin')) {
          let _v; try { _v = ctx.window[_k]; } catch (e3) { _v = 'ERR'; }
          _ok.push(_k + '=' + (typeof _v) + ':' + String(_v).slice(0, 40));
        }
      }
      log('[PROBE-ORIGIN] win origin-like: ' + _ok.join(', ') + ' | loc.origin=' +
        (typeof ctx.window.location.origin) + ':' + String(ctx.window.location.origin).slice(0, 40));
    } catch (e) { log('[PROBE-ORIGIN] err: ' + e.message); }
    if (process.env.PROBE_WIN) {
      try {
        const ks = Object.keys(ctx);
        log('[PROBE-TAIL] keys=' + ks.length + ' tail=' + JSON.stringify(ks.slice(-25)) +
          ' tsIdx=' + ks.indexOf('$_ts') + ' tlIdx=' + ks.indexOf('__taskLog'));
        log('[PROBE-TAIL] tlEnum=' + JSON.stringify(Object.getOwnPropertyDescriptor(ctx, '__taskLog')));
        log('[PROBE-TAIL] inProto=' + vmMod.runInContext('(function(){var g1=Object.getPrototypeOf(window);var g2=g1&&Object.getPrototypeOf(g1);' +
          'var fi=[];for(var k in window){if(fi.length<2000)fi.push(k);}' +
          'var fi2=[];for(var k2 in g1){fi2.push(k2);}var fi3=[];for(var k3 in g2){fi3.push(k3);}' +
          'return "g2keys:"+Object.keys(g2).join(",")+" fiTail:"+fi.slice(-4).join(",")+" g1forin:"+fi2.join(",")+" g2forin:"+fi3.join(",");})()', ctx));
        const _fiHost=[];for(const _kH in ctx.window){_fiHost.push(_kH);if(_fiHost.length>400)break;}
        const _ctxProto=Object.getPrototypeOf(ctx);
        log('[PROBE-TAIL] hostWinIsProxy=' + (ctx.window === winProxy) + ' ctxProtoKeys=' + Object.keys(_ctxProto).join(',') + ' ctxProtoParentKeys=' + Object.keys(Object.getPrototypeOf(_ctxProto)).join(',') + ' hostForInTail=' + _fiHost.slice(-5).join(','));
      } catch (e) { log('[PROBE-TAIL] err: ' + e.message); }
    }
    for (const p of ck.split(';')) {
      const t = p.trim();
      if (t.includes('=')) log(`  cookie: ${t.split('=')[0]}`);
    }
    process.stdout.write(ck);
    process.exit(ck ? 0 : 1);
  }

  // ★ 2026-08-19 回退: cookie 正常写入容器, 直接读容器 (sdenv 参照形态)
  //   [旧方案] __pCookie 旁路拼接 — 污染 window for-in → 指纹分叉 → 400
  const getCookie2 = () => getCookie();

  const check = setInterval(() => {
    const c = getCookie2();
    if (evalCaps.length) {
      const fsx = require('fs');
      try {
        fsx.writeFileSync('eval_capture_mine.txt',
          evalCaps.map((x, i) => '\n/* ==== CHUNK ' + i + ' (' + x.length + 'b) ==== */\n' + x).join('\n'),
          'utf-8');
      } catch (e) {}
    }
    if (c.length !== lastLen) {
      lastLen = c.length;
      stableCount = 0;
    } else if (c.length >= 100) {
      stableCount++;
      // ★ 最少跑 12s: sdenv 实测 383→357 (enable_ 删除) 发生在 ~2s,
      //   过早退出会跳过 VM 后半段异步流 (03:22 轮 sdenv 任务 100001 条 vs nodenv 83128 条 —
      //   末尾 64-209 任务 + 336B Feistel 从未执行 → 稳定 6 次 + 12s 门槛)
      if (stableCount >= 6 && Date.now() - t0 > 12000) {
        clearInterval(check); clearTimeout(hardStop); finish(c);
      }
    }
  }, 500);

  const hardStop = setTimeout(() => {
    clearInterval(check);
    finish(getCookie2());
  }, waitSec * 1000);
}

main().catch(err => {
  log('FATAL: ' + err.message);
  process.exit(1);
});
