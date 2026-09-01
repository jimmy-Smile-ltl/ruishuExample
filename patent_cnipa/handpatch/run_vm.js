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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

function log(msg) {
  process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

function setGlobal2Eval(win, origEval, caps, logFn) {
  // ★ 插桩: 分发器 + 解释器操作码追踪 (名字无关正则)
  win.__dbg = (m) => logFn('[DBG] ' + m);
  win.__dbgIdx = 0;
  win.eval = function (code) {
    if (typeof code === 'string' && code.length > 50) {
      caps.push(code);
      logFn(`[EVAL] captured ${code.length}b (total ${caps.length})`);
      // 1. 构造分发器: ctor + args 记录
      const dispRe = /function (_\$\w+)\((_\$\w+),(_\$\w+)\)\{if\(\3\.length===0\)return new \2\(\);/;
      if (dispRe.test(code)) {
        code = code.replace(dispRe, function (m, fname, ctor, arr) {
          return 'function ' + fname + '(' + ctor + ',' + arr + '){if(' + arr +
            '.length>3||String(' + ctor + ').indexOf("Error")>-1){try{__dbg("ctor="+String(' + ctor +
            ').slice(0,50)+" args="+' + arr + '.length+" v0="+String(' + arr +
            '[0]).slice(0,60))}catch(e){}}if(' + arr + '.length===0)return new ' + ctor + '();';
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
      // 2.5. opcode-15 方法调用插桩: _$$Z=_$$Z[_$kg],..._$$Z(args)
      const callRe = /(_\$\w+)=\[(_\$\w+)\],_\$\w+\[_\$\w+\+\+\s*\]=\(_\$\w+\[_\$\w+\],/;
      if (callRe.test(code)) {
        code = code.replace(callRe, function (m, objv, keyv, a1) {
          return objv + '=' + objv + '[' + keyv + '],' +
            'try{__dbg("CALL:"+String(' + objv + ').slice(0,20)+"."+String(' + keyv + '))}catch(e){},' +
            '_$if[_$eS++]=' + objv + '(' + a1 + ',';
        });
        logFn('[EVAL] call opcode instrumented');
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
    }
    return origEval(code);
  };
}

async function main() {
  const htmlFile = process.argv[2];
  const pageUrl = process.argv[3];
  let vmPath = process.argv[4];
  const args = process.argv.slice(4);
  const debug = args.includes('--debug');
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
    return _siNative(fn, d);
  };
  // env.js 会用这些 (包装后的) timer 再包一层 try/catch — 保持顺序

  // ── 3. 干净沙箱 (vm.createContext) + 构建环境 ──────────────
  // ★ 关键: VM 通过 window.top/window.parent 等能看见的必须是干净 realm,
  //   不能暴露 Node 的 process/require/Buffer (jsdom 同构)
  const vmMod = require('vm');
  const sandbox = {
    console: globalThis.console,
    Date, Math, JSON, Array, Object, String, Number, Boolean, RegExp, Error,
    TypeError, SyntaxError, RangeError, Promise, Proxy, Reflect, Symbol,
    Map, Set, WeakMap, WeakSet, ArrayBuffer, Uint8Array, Uint8ClampedArray,
    Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array,
    Float32Array, Float64Array, DataView, TextEncoder, TextDecoder,
    decodeURIComponent, encodeURIComponent, decodeURI, encodeURI,
    isNaN, isFinite, parseFloat, parseInt, NaN, Infinity, undefined,
  };
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
  vmMod.createContext(sandbox);
  // ★ 上下文内 eval/Function: 在 sandbox realm 中执行 (不是外层 Node realm)
  // filename 用页面 URL: Error.stack 帧显示浏览器风格而非 evalmachine
  const _rawEval = (code) => vmMod.runInContext(String(code), sandbox, { filename: pageUrl });
  const ctxEval = function eval(...args) { return _rawEval(args[0]); };
  Object.defineProperty(ctxEval, 'name', { value: 'eval', configurable: true });
  Object.defineProperty(ctxEval, 'toString', {
    value: () => 'function eval() { [native code] }',
  });
  sandbox.eval = ctxEval;
  const ctxFunction = function Function(...args) {
    const body = String(args.pop() || '');
    const params = args.join(',');
    return vmMod.runInContext(`(function(${params}){${body}})`, sandbox, { filename: pageUrl });
  };
  Object.defineProperty(ctxFunction, 'name', { value: 'Function', configurable: true });
  Object.defineProperty(ctxFunction, 'toString', {
    value: () => 'function Function() { [native code] }',
  });
  sandbox.Function = ctxFunction;
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
  const { win, getCookie, log: envLog } = buildEnv({
    url: pageUrl, ua: UA, nsd, cd, metaId, metaContent, scriptSrc: absScriptSrc, debug,
    inlineScripts,
    win: sandbox,
    crypto: globalThis.crypto,
  });
  // env.js 内部把 eval 设成了外层 eval, 改回上下文 eval
  win.eval = ctxEval;

  // ★ 全序列窗口观测 (与 _seq_sdenv.js 同款, 供 diff)
  const seqLog = [];
  const seqNote = (m) => seqLog.push(m);
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
            get() { seqNote('W:' + k + '=' + String(v).slice(0, 22)); return v; },
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

  // ★ $_ts 属性写入 hook (与 ts_trace_sdenv.js 同款)
  let _tswSeq = 0;
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

  // ★ 拦截 VM 对 $_ts 的重置 (opcode 10 会 $_ts={})
  const tsObj = win['$_ts'];
  Object.defineProperty(win, '$_ts', {
    value: tsObj, writable: false, configurable: false, enumerable: true,
  });

  // ★ eval 捕获 (对比 sdenv 生成代码) — 包上下文 eval
  const evalCaps = [];
  const _origEval = ctxEval;
  setGlobal2Eval(win, _origEval, evalCaps, log);

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
      try {
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
        vmMod.runInContext(vmCode, sandbox, { filename: absScriptSrc || 'vm.js' });
        vmEvaled = true;
        log('VM loaded');
        // ★ 检查 codegen 后的 $_ts 结构 + 完整 dump 解码产物
        try {
          const tsSnap = vmMod.runInContext(
            "JSON.stringify(Object.keys($_ts||{}).map(function(k){var v=$_ts[k];" +
            "return k+':'+(Array.isArray(v)?('arr['+v.length+']0='+String(v[0]||'').slice(0,20)):String(v).slice(0,40));}))",
            sandbox);
          log('[TS] ' + tsSnap);
          const dump = vmMod.runInContext(
            "JSON.stringify({scj: $_ts.scj, aebi: $_ts.aebi, cp: $_ts.cp})", sandbox);
          require('fs').writeFileSync('ts_dump.json', dump, 'utf-8');
          log('[TS-DUMP] saved ts_dump.json (' + dump.length + 'b)');
        } catch (e) { log('[TS] err: ' + e.message); }
        const funcs = Object.getOwnPropertyNames(win).filter(k => k.startsWith('_$') && typeof win[k] === 'function');
        log(`Global _$ funcs (${funcs.length}): ${funcs.slice(0, 25).join(', ')}`);
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
    try {
      vmMod.runInContext(item.body, sandbox, { filename: pageUrl });
    } catch (e) {
      log(`Inline eval error: ${e.message}`);
      log((e.stack || '').split('\n').slice(0, 6).join('\n'));
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
    '_$nB', '_$eH', '_$$k', '_$_s', '_$ic', '_$ln']) {
    tryCall(name);
  }

  // ── 6. 轮询 cookie ────────────────────────────────────────
  log(`Waiting up to ${waitSec}s for cookie...`);
  const t0 = Date.now();
  let lastLen = 0, stableCount = 0;

  function finish(ck) {
    try { require('fs').writeFileSync('seq_mine.txt', seqLog.join('\n'), 'utf-8'); } catch (e) {}
    log(`RESULT: ${ck.length} chars @${((Date.now() - t0) / 1000).toFixed(1)}s`);
    for (const p of ck.split(';')) {
      const t = p.trim();
      if (t.includes('=')) log(`  cookie: ${t.split('=')[0]}`);
    }
    process.stdout.write(ck);
    process.exit(ck ? 0 : 1);
  }

  const check = setInterval(() => {
    const c = getCookie();
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
      if (stableCount >= 2) { clearInterval(check); clearTimeout(hardStop); finish(c); }
    }
  }, 500);

  const hardStop = setTimeout(() => {
    clearInterval(check);
    finish(getCookie());
  }, waitSec * 1000);
}

main().catch(err => {
  log('FATAL: ' + err.message);
  process.exit(1);
});
