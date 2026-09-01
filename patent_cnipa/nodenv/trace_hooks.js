function traceTaskExec(code, logFn) {
  const re = new RegExp(
    'function (_\\$\\w+)\\(([\\w$]+),([\\w$]+),([\\w$]+),([\\w$]+)\\)\\{var [^;]+;' +
    '([\\w$]+)=\\2\\.([\\w$]+),([\\w$]+)=\\5\\[2\\],([\\w$]+)=\\5\\[3\\],' +
    '([\\w$]+)=\\5\\[0\\],([\\w$]+)=\\5\\[1\\],([\\w$]+)=([\\w$]+)\\.([\\w$]+)\\(\\),([\\w$]+)=0;'
  );
  const m = re.exec(code);
  if (!m) return code;
  // ★ 分析用落盘: 匹配到的执行器上下文源码 (含 switch case 实现)
  try {
    require('fs').writeFileSync('executor_dump.js', '/* m0len=' + m[0].length + ' */\n' +
      code.slice(Math.max(0, m.index - 60000), m.index + 60000), 'utf-8');
  } catch (e) {}
  const [, fn, p1, p2, p3, p4, tv, tprop, tb, tc, td, te, stk, so, sm, cur] = m;
  // ★ 额外: 工厂里的 taskarr 字符串转换点 X.P.charCodeAt?X.P=Z(X.P):0 — 记录原始字符串
  const rawRe = new RegExp(
    '([\\w$]+)\\.([\\w$]+)\\.charCodeAt\\?\\1\\.\\2=([\\w$]+)\\(\\1\\.\\2\\):0'
  );
  // raw hook 移除 (不稳定) — offset 捕获只需 entry/exit
  // ★ 收集执行器体的自由表名 (供首次调用时 dump 真实值)
  const bodyStart = m.index + m[0].indexOf('{') + 1;
  const bodyEnd = Math.min(bodyStart + 12000, code.length);
  // 剥离字符串字面量再扫名字 (避免 'use' 之类污染)
  let execBody = code.slice(bodyStart, bodyEnd)
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, '``');
  // 不截止 (嵌套解码器的局部名会 dump 成 undef, 无害; 全表名一个不漏)
  const localNames = new Set([fn, p1, p2, p3, p4, tv, tb, tc, td, te, stk, so, sm, cur]);
  const tableNames = [];
  {
    const seen = new Set();
    const refRe = /([\w$]+)\[/g;
    let rm2;
    while ((rm2 = refRe.exec(execBody)) !== null) {
      const name = rm2[1];
      if (localNames.has(name) || seen.has(name)) continue;
      if (name === 'Array' || name === 'String' || name === 'JSON' || name === 'Object') continue;
      seen.add(name);
      tableNames.push(name);
    }
  }
  // ★ 槽位精确提取: 按 op 臂结构定位各表名 (确定性, 不受名字收集干扰)
  const slotNames = {};
  {
    const bytePat = '[\\w$]+\\[\\s*\\+\\+\\s*[\\w$]+\\]';
    const slotPats = {
      T_GLOBAL: new RegExp('<=2\\?[^:]{0,80}=([\\w$]+)\\[[\\w$]+\\['),
      T_8: new RegExp('<=10\\?\\([^)]{0,80}=([\\w$]+)\\[\\s*[\\w$]+\\['),
      T_V: new RegExp('<=13\\?\\([^)]{0,80}=([\\w$]+)\\[\\s*[\\w$]+\\['),
      T_T: new RegExp('<=23\\?\\([^)]{0,100}=([\\w$]+)\\[[\\w$]+\\],[\\w$]+\\[[\\w$]+\\]='),
      T_GW: new RegExp('<=35\\?\\([\\w$]+=[\\w$]+\\[\\s*\\+\\+\\s*[\\w$]+\\],[\\w$]+=([\\w$]+)\\)'),
      T_P: new RegExp('<=67\\?\\([^)]{0,100},[\\w$]+=([\\w$]+)\\[[\\w$]+\\],[\\w$]+=[\\w$]+\\[[\\w$]+\\]'),
      // ★ 2026-08-31: ACC/KEY 寄存器变量名 (op16: mz(),oZ=oZ[mS],... — undefined.toString 异常源)
      ACC: new RegExp('_?[\\w$]+\\(\\),([\\w$]+)=\\1\\[([\\w$]+)\\],'),
      // ★ 2026-08-31: hV 表 (op12: push hV[byte] — 任务入口参数表, Canvas getImageData 检测源)
      HV: new RegExp('<=12\\?[^:]{0,40}=([\\w$]+)\\[[\\w$]+\\['),
      // ★ 2026-08-31: jb 表 (op55: 锚定 '=[]:(oV=n8[++],dR[++]=jb[oV][n8[++]])' 尾部 — op14 同构须用 []: 前缀)
      JB: /\[\]:\([\w$]+=[\w$]+\[\s*\+\+\s*[\w$]+\],[\w$]+\[[\w$]+\s*\+\+\s*\]=([\w$]+)\[[\w$]+\]\[/,
      // ★ 2026-09-01: _$$H 表 (op2: push _$$H[byte] — 0-76 调度分叉 4vs3 的直接源)
      H2: /<=2\?[\w$]+\[[\w$]+\s*\+\+\s*\]\s*=\s*([\w$]+)\[/,
    };
    const bodyAll = code.slice(bodyStart, Math.min(bodyStart + 60000, code.length));
    for (const [slot, pat] of Object.entries(slotPats)) {
      const sm2 = pat.exec(bodyAll);
      if (sm2) slotNames[slot] = sm2[1];
      // ★ ACC 正则带 2 捕获 (oZ, mS) — MS 存第 2 组
      if (sm2 && slot === 'ACC' && sm2[2]) slotNames.MS = sm2[2];
    }
    // T_GLOBAL 兜底: chunk init 的 NAME=DATA[349] 直接赋值点
    if (!slotNames.T_GLOBAL) {
      const initRe = /([\w$]+)=([\w$]+)\[349\],/;
      const im = initRe.exec(code);
      if (im) slotNames.T_GLOBAL = im[1];
    }
    logFn('[TRACE-TASK] slots: ' + JSON.stringify(slotNames));
  }
  // 直接引用 (preamble 注入在执行器作用域内, 直接引用闭包表可见) — 全量捕获
  const dumpExpr = (t) =>
    'try{__tb[' + JSON.stringify(t) + ']=typeof ' + t + '==="undefined"?"undef":(typeof ' + t +
    '==="function"?String(' + t + ').slice(0,50):(' + t + '&&' + t + '.slice?' +
    '(' + t + '.length>800?JSON.stringify(' + t + '.slice(0,800))+"__TRUNC:"+' + t +
    '.length:JSON.stringify(' + t + ')):(typeof ' + t + '==="object"?' +
    '(function(){var __o={};var __n=0;try{for(var __kk in ' + t +
    '){if(__n++>800)break;var __vv=' + t + '[__kk];__o[__kk]=typeof __vv==="object"?' +
    '(__vv&&__vv.slice?("a"+__vv.length+"="+String(__vv.slice(0,4))):"[o]"):__vv;}}catch(__e5){}' +
    'return JSON.stringify(__o);})():JSON.stringify(' + t + '))));}' +
    'catch(__te){try{__tb[' + JSON.stringify(t) + ']="ERR:"+typeof ' + t + '+((' + t +
    '&&' + t + '.length)?":"+(' + t + '.length):"");}catch(__te3){}}';
  const tableDumpParts = tableNames.slice(0, 20).map(dumpExpr);
  // 槽位表 + 哨兵值 (按槽位名记录, 带错误信息)
  // ★ 关键索引直读: GLOBAL[13]/[41]/[74]/[3] (过滤器函数/调用表/UA槽位)
  for (const [slot, name] of Object.entries(slotNames)) {
    if (slot === 'T_GLOBAL') {
      tableDumpParts.push(
        'try{__tb.SLOT_TG_IDX="[13]="+(typeof ' + name + '[13]==="function"?String(' + name + '[13]).slice(0,90):String(' + name + '[13]).slice(0,30))+' +
        '" [41]="+(typeof ' + name + '[41]==="function"?String(' + name + '[41]).slice(0,90):String(' + name + '[41]).slice(0,30))+' +
        '" [74]="+(typeof ' + name + '[74]==="function"?String(' + name + '[74]).slice(0,90):String(' + name + '[74]).slice(0,30))+' +
        '" [3]="+(typeof ' + name + '[3]==="function"?String(' + name + '[3]).slice(0,60):String(' + name + '[3]).slice(0,30))+' +
        '" [88]="+(typeof ' + name + '[88]==="function"?String(' + name + '[88]).slice(0,90):String(' + name + '[88]).slice(0,40))+' +
        '" [87]="+(typeof ' + name + '[87]==="function"?String(' + name + '[87]).slice(0,90):String(' + name + '[87]).slice(0,40));}catch(__e7){}'
      );
    }
  }
  for (const [slot, name] of Object.entries(slotNames)) {
    tableDumpParts.push(
      'try{var __sv=' + name + ';if(typeof __sv==="undefined"){__tb[' + JSON.stringify('SLOT_' + slot) +
      ']="undef";}else if(typeof __sv==="function"){__tb[' + JSON.stringify('SLOT_' + slot) +
      ']="fn:"+String(__sv).slice(0,50);}else if(__sv&&__sv.slice&&typeof __sv!=="string"){' +
      '__tb[' + JSON.stringify('SLOT_' + slot) + ']="arr["+__sv.length+"]="+String(__sv.slice(0,300));}else if(typeof __sv==="object"){' +
      'var __o="";var __n=0;try{for(var __kk in __sv){if(__n++>250)break;var __vv=__sv[__kk];' +
      '__o+=__kk+"="+(typeof __vv==="object"?("[o"+(__vv&&__vv.length?""+__vv.length:"")+"]"):String(__vv).slice(0,30))+";";}}catch(__e5){__o+="ERR:"+__e5;}' +
      '__tb[' + JSON.stringify('SLOT_' + slot) + ']="obj len="+__n+":"+__o;}else{' +
      '__tb[' + JSON.stringify('SLOT_' + slot) + ']=String(__sv).slice(0,200);}}catch(__te2){try{' +
      '__tb[' + JSON.stringify('SLOT_' + slot) + ']="ERR:"+String(__te2);}catch(__te3){}}'
    );
  }
  // ★ T_GLOBAL/T_GW 特定键值 dump (直接引用 71/85/43/18/10/53/4/0/96/27/113)
  for (const [slot, name] of [['T_GLOBAL', slotNames.T_GLOBAL], ['T_GW', slotNames.T_GW]]) {
    if (!name) continue;
    tableDumpParts.push(
      'try{var __tvo=[];for(var __tvn of [94,107,78,71,85,43,18,10,53,4,0,96,27,113,2,37,57,58,59,60,115,116,117,118,119,120]){var __tvx=' + name + '[__tvn];' +
      '__tvo.push(__tvn+"="+(typeof __tvx==="object"?(__tvx&&__tvx.slice?("arr"+__tvx.length+"=["+String(__tvx.slice(0,80))+"]"):"[o]"):String(__tvx).slice(0,60)));}' +
      '__tb[' + JSON.stringify('SLOT_' + slot + '_keys') + ']=__tvo.join(";");}catch(__te4){}'
    );
  }
  {
    const sentRe = /==([\w$]+)\?[\w$]+=[\w$]+\[\s*\+\+\s*[\w$]+\]:\s*\+\+\s*[\w$]+,[\w$]+\+=/;
    const sm3 = sentRe.exec(code.slice(bodyStart, Math.min(bodyStart + 60000, code.length)));
    if (sm3) tableDumpParts.push(dumpExpr('SENT_' + sm3[1]));
  }
  // ★ 事件日志钩子: cookie 元数据构建器的 X=Y[Y[K]-1].P (首末时间戳) — 记录事件数
  if (!process.env.NO_EVLOG) {
    const evRe = /([\w$]+)=([\w$]+)\[([\w$]+)\[[\w$]+\[[\w$]+\]\]\s*-\s*1\s*\]\.([\w$]+)/g;
    const em = evRe.exec(code);
    if (em) {
      let evCnt = 0;
      code = code.replace(evRe, (match, cdv, logv, lenk, propv) => {
        evCnt++;
        return match + ',console.log("[EVDBG] loglen="+' + logv + '[' + lenk + ']+" first="+' + logv + '[0].' + propv + '),typeof __evlog!=="undefined"&&__evlog.length<100?__evlog.push({len:' + logv + '[' + lenk + '],first:' + logv + '[0].' + propv + ',last:' + logv + '[' + logv + '[' + lenk + ']-1].' + propv + '}):0';
      });
      if (evCnt) logFn('[TRACE-TASK] eventlog hook x' + evCnt + ': ');
    }
  }
  const preamble =
    'function ' + fn + '(' + p1 + ',' + p2 + ',' + p3 + ',' + p4 + '){' +
    'var __sh=function(v){if(v===undefined)return "undef";if(v===null)return "null";' +
    'if(Array.isArray(v)){var __h=[];try{for(var __j=0;__j<Math.min(v.length,8);__j++){var __x=v[__j];__h.push(__x===null?"null":typeof __x==="object"?"[obj]":__x);}}catch(e){}return "arr["+v.length+"] head="+JSON.stringify(__h);}' +
    'if(typeof v==="function")return "fn:"+String(v).slice(0,30);' +
    'if(typeof v==="object"){var __ks=[];try{__ks=Object.keys(v).slice(0,8);}catch(e){}' +
    'var __vs=[];try{for(var __z=0;__z<__ks.length;__z++){var __vv=v[__ks[__z]];' +
    '__vs.push(__ks[__z]+"="+(typeof __vv==="object"?"[o]":String(__vv).slice(0,20)));}}catch(e){}' +
    'return "[obj{"+__vs.slice(0,6).join(",")+"}]";}' +
    'return typeof v+":"+String(v).slice(0,40);};' +
    'try{if(typeof __taskLog!=="undefined"&&__taskLog.length<5000){' +
    'try{__taskLog.push({start:' + p2 + ',end:' + p3 + ',' +
    'bytes:(' + p1 + '&&' + p1 + '.' + tprop + ')?Array.prototype.slice.call(' + p1 + '.' + tprop +
    ',' + p2 + ',Math.min(' + p3 + ',' + p2 + '+400)):[],' +
    't0:__sh(' + p4 + '&&' + p4 + '[0]),t1:__sh(' + p4 + '&&' + p4 + '[1]),' +
    't2:__sh(' + p4 + '&&' + p4 + '[2]),t3:__sh(' + p4 + '&&' + p4 + '[3]),' +
    '__args:(function(){var __a=' + p4 + '&&' + p4 + '[0];if(__a===undefined)return null;' +
    'var __o="";var __n=0;try{for(var __kk in __a){if(__n++>20)break;var __vv=__a[__kk];' +
    '__o+=__kk+"="+(typeof __vv==="object"?(__vv&&__vv.slice?("arr"+__vv.length+"=["+String(__vv.slice(0,30))+"]"):(function(){var __ks2=[];try{__ks2=Object.keys(__vv).slice(0,12);}catch(e){}var __vs2="{";for(var __z2=0;__z2<__ks2.length;__z2++){var __v2=__vv[__ks2[__z2]];__vs2+=__ks2[__z2]+"="+(typeof __v2==="function"?String(__v2).slice(0,30):String(__v2).slice(0,25))+";";}return __vs2+"}";})()):String(__vv).slice(0,60))+";";}}catch(__e6){__o+="ERR:"+__e6;}' +
    'return __o;})()});' +
    '}catch(__er){__taskLog.push({entryerr:String(__er)});}' +
    'if(__taskLog&&!__taskLog.tbd){__taskLog.tbd=1;var __tb={};' + tableDumpParts.join('') +
    '__taskLog.push({tables:__tb});}' +
    '}}catch(e){}';
  // ★ 任务分段标记: 每次执行器进入时在 oplog 打 '===T:start-end:B=len'
  //   (用 typeof 保护: 不触碰 VM 值, 零 trap)
  {
    const taskMark =
      // task seq counter (aligned with _find_fork split_tasks: first entry=0)
      'if(typeof __taskNo==="undefined"){__taskNo=0;}else{__taskNo=__taskNo+1;}' +
      'try{if(typeof window!=="undefined"){window.__curtask=' + p2 + '+":"+' + p3 + '+":"+__taskNo;}}catch(__e0c){}' +
      'try{if(typeof __oplog!=="undefined"&&__oplog.length<10000000){__oplog.push("===T:"+' + p2 + '+"-"+' + p3 + '+" n="+__taskNo+" B="+(typeof ' + p1 + '.' + tprop + '!=="undefined"?' + p1 + '.' + tprop + '.length:-1));' +
      // ★ 2026-09-01: 段字节码 dump (87182 任务表对比) — 独立数组
      'try{if(typeof __segdump!=="undefined"&&__segdump.length<200000){__segdump.push(' + p2 + '+"-"+' + p3 + '+":"+String(' + p1 + '.' + tprop + '.slice(' + p2 + ',' + p3 + ')));}}catch(__e){}' +
      'if(' + p2 + '===0&&' + p3 + '===76){try{var __h0=' + p4 + '&&' + p4 + '[0];var __v42=null;try{__v42=__h0[42];}catch(__e42a){__v42="trap:"+String(__e42a).slice(0,20);}var __hlen="na";try{__hlen=__h0.length;}catch(__e42b){}' +
      (slotNames.H2 ?
        'var __h2s="na";try{var __h2v=' + slotNames.H2 + '[71];__h2s=String(__h2v).slice(0,20)+";len="+(typeof ' + slotNames.H2 + '.length==="number"?' + slotNames.H2 + '.length:"na");}catch(__e42c){__h2s="ERR:"+String(__e42c).slice(0,30);}' : 'var __h2s="noH2";') +
      'var __jb3s="na";try{var __jb3=' + p4 + '&&' + p4 + '[3]&&' + p4 + '[3][3];var __jb32=__jb3?__jb3[2]:null;__jb3s="jb3="+typeof __jb3+";jb32="+String(__jb32).slice(0,24)+";len="+(typeof __jb3==="object"&&__jb3?String(__jb3.length).slice(0,8):"na")+";ctor="+(function(){try{var __c=__jb3&&__jb3.constructor;return __c?String(__c).slice(0,20):"none";}catch(__e42e){return "err";}})();}catch(__e42f){__jb3s="ERR:"+String(__e42f).slice(0,40);}' +
      '__oplog.push("===H76:v42="+String(__v42).slice(0,24)+";len="+__hlen+";t="+(typeof __h0)+";ctor="+(function(){try{var __c=__h0&&__h0.constructor;return __c?String(__c).slice(0,24):"none";}catch(__e42d){return "err";}})()+";H2[71]="+__h2s+";JB="+__jb3s);}catch(__e76){try{__oplog.push("===H76ERR:"+String(__e76).slice(0,120));}catch(__e76b){}}}' +
      'if(' + p2 + '===0&&' + p3 + '===131){try{var __b131=' + p1 + '.' + tprop + ';__oplog.push("===BC131:"+JSON.stringify(__b131));}catch(__e131){__oplog.push("===BC131ERR");}}' +
      'if(' + p2 + '===0&&' + p3 + '===131){try{var __fk1=(typeof _$fK==="function"?("F:"+String(_$fK).slice(0,60)):(typeof _$fK==="object"?(_$fK===null?"null":("[o]"+(typeof _$fK.slice!=="undefined"?"arr"+_$fK.length:"")+" eqstk="+(_$fK===' + stk + ')+" eqtv="+(_$fK===' + tv + '))):(""+_$fK)));__oplog.push("===T1FK:"+__fk1+"|l6="+(typeof _$l6==="number"?("n"+_$l6):(typeof _$l6==="string"?(\'"\'+_$l6.slice(0,20)+\'"\'):typeof _$l6))+"|bx="+(typeof _$bx)+"|lw="+_$lw+"|m="+(typeof _$_m==="object"?("obj"+(typeof _$_m.slice!=="undefined"?"arr"+_$_m.length:"")):typeof _$_m));}catch(__eT1){__oplog.push("===T1FK-ERR");}}' +
      'if(' + p2 + '===0&&' + p3 + '===44){try{var __n44=[];for(var __i44=0;__i44<44;__i44++){var __b44=' + p1 + '.' + tprop + '[__i44];__n44.push(typeof __b44==="string"?("s:"+__b44):(typeof __b44==="number"?("n:"+__b44):(typeof __b44==="function"?("f:"+String(__b44).slice(0,20)):(typeof __b44==="object"?((__b44&&__b44.slice)?("a"+__b44.length):"[o]"):String(__b44)))));}__oplog.push("===N44:"+__n44.join(","));}catch(__e44){__oplog.push("===N44ERR:"+String(__e44).slice(0,120));}}' +
      'if(' + p2 + '===5&&' + p3 + '===530){try{var __n530=[];for(var __i530=0;__i530<100;__i530++){var __b530=' + p1 + '.' + tprop + '[__i530];__n530.push(typeof __b530==="string"?("s:"+__b530):(typeof __b530==="number"?("n:"+__b530):(typeof __b530==="function"?("f:"+String(__b530).slice(0,15)):(typeof __b530==="object"?((__b530&&__b530.slice)?("a"+__b530.length):"[o]"):String(__b530)))));}__oplog.push("===D530:"+__n530.join(","));}catch(__e530){__oplog.push("===D530ERR");}}' +
      'if(' + p2 + '===0&&' + p3 + '===44){try{__oplog.push("===S44:"+String(new Error().stack).slice(0,700));}catch(__e44s){}}' +
      'if(' + p2 + '===0&&' + p3 + '===30){try{' +
      'var __a30=' + p4 + '&&' + p4 + '[0];var __ks30=[];try{for(var __kk30 in __a30){__ks30.push(__kk30);if(__ks30.length>=6)break;}}catch(__e9){}' +
      'var __wk30=[];try{for(var __wkk30 in window){__wk30.push(__wkk30);if(__wk30.length>=400)break;}}catch(__e10){}' +
      '__oplog.push("===ARG30:"+__ks30.join(",")+" | WIN:"+__wk30.slice(0,6).join(",")+" | WINALL:"+__wk30.join(",")+" | t0:"+typeof window[__wk30[0]]+" | isWin:"+(' + p4 + '[0][0]===window)+" | proto:"+((function(){try{var __p90=Object.getPrototypeOf(window);var __r84="";var __n84=0;for(var __k84 in __p90){__r84+=__k84+",";if(++__n84>=6)break;}return __r84;}catch(__e84){return "ERR";}})())+" | a1keys:"+((function(){try{var __r83="";var __n83=0;for(var __k83 in ' + p4 + '[0][0]){__r83+=__k83+",";if(++__n83>=4)break;}return __r83;}catch(__e83){return "ERR";}})()));' +
      '}catch(__e11){}}' +
      'if(' + p2 + '===0&&(' + p3 + '===347||' + p3 + '===140||' + p3 + '===142)){try{' +
      'var __dp=' + p4 + '&&' + p4 + '[0];var __dd=[];' +
      'var __dl=0;try{__dl=__dp.length;}catch(__edl){}' +
      'for(var __di=0;__di<Math.min(__dl,8);__di++){var __dv=__dp[__di];' +
      'if(typeof __dv==="object"&&__dv&&__dv.slice){var __inner=[];try{for(var __dj=0;__dj<Math.min(__dv.length,300);__dj++){var __ij=__dv[__dj];__inner.push(typeof __ij==="string"?("s:"+__ij.slice(0,30)):(typeof __ij==="number"?("n:"+__ij):(typeof __ij==="function"?("f"):String(__ij))));}}catch(__ej){__inner.push("ERR:"+__ej);}' +
      '__dd.push("a"+__dv.length+"=["+__inner.join(",")+"]");}' +
      'else{__dd.push(typeof __dv==="string"?("s:"+__dv.slice(0,30)):(typeof __dv==="number"?("n:"+__dv):(typeof __dv==="function"?("f:"+String(__dv).slice(0,20)):(typeof __dv==="object"?"[o]":String(__dv)))));}}' +
      '__oplog.push("===DP' + p3 + ':"+__dl+":"+__dd.join(","));' +
      '}catch(__edp){try{__oplog.push("===DPERR:' + p3 + ':"+String(__edp).slice(0,120));}catch(__edp2){}}}' +
      '}' +
      '}catch(e){}';
    // ★ 必须用函数 replacement: preamble 里含 _\$xxx 变量名,
    //   字符串 replacement 会把 \$& / \$1-\$99 展开成特殊模式 (如 _\$e\$& → _\$e+整个匹配),
    //   破坏注入代码. 函数返回值不解释 \$ 模式.
    code = code.replace(m[0].slice(0, m[0].indexOf('{') + 1), () => preamble + taskMark);
  }
  // ★ 递归 dispatcher catch 插桩: 异常被吞进结果数组前先记录 (factory 级, 非 executor)
  //   标志模式: catch(X){ARRAY[IDX]=X,  (catch 参数直接存入数组)
  {
    const exRe = /catch\(([\w$]+)\)\{([\w$]+)\[([\w$]+)\]=([\w$]+),/g;
    let exCnt = 0;
    code = code.replace(exRe, (all, p, a, b, c) => {
      if (p !== c) return all;
      exCnt++;
      return 'catch(' + p + '){try{if(typeof __exnLog!=="undefined"&&__exnLog.length<500){' +
        '__exnLog.push({msg:String(' + p + '&&' + p + '.message||' + p + ').slice(0,220),' +
        'stack:String(' + p + '&&' + p + '.stack||"").slice(0,2000),' +
        'task:(typeof __taskNo!=="undefined"?__taskNo:-1),' +
        'last:(function(){try{var __tl=(typeof window!=="undefined"?window.__taskLog:null);if(__tl&&__tl.length){var __t=__tl[__tl.length-1];var __b=[];try{var __arr=__t.bytes||__t.__bytes||[];for(var __i=0;__i<__arr.length&&__i<40;__i++)__b.push(__arr[__i]);}catch(__z2){}return "s"+__t.start+"-e"+__t.end+"["+__b.join(",")+"]";}return "no";}catch(__z){return "err:"+String(__z).slice(0,40);}})(),' +
        'stk:(function(){try{var __r="";var __i=Math.max(0,' + stk + '.length-6);for(;__i<' + stk + '.length;__i++){__r+=(""+(function(__v){var __t=typeof __v;if(__t==="object"){return __v===null?"null":"[o]";}if(__t==="function"){try{return "[f]"+String(__v).slice(0,30);}catch(__e3){return "[f]";}}return String(__v);})(' + stk + '[__i])).slice(0,24)+";";}return __r;}catch(__z){return "err:"+String(__z).slice(0,40);}})()});}}catch(__exe2){}' +
        a + '[' + b + ']=' + c + ',';
    });
    if (exCnt) logFn('[TRACE-TASK] catch-exn hook x' + exCnt);
  }
  // ★ TEMP-DEBUG: op47/op49 运行时值探查 (stack 列 96674 = 执行器 opcode 分支)
  //   ★ 必须用函数 replacement! 字符串里 $$ 会被 String.replace 展开成字面 $, 破坏函数名
  {
    const p47 = '_$bx=_$fK[_$l6](_$_m[_$bx])';
    const p49 = '_$bx=_$_m[--_$lw]>_$bx';
    const c47 = code.split(p47).length - 1;
    const c49 = code.split(p49).length - 1;
    logFn('[TRACE-TASK] op47 x' + c47 + ' op49 x' + c49);
    if (c47 > 0) {
      code = code.replace(p47, () =>
        '_$bx=((function(){try{' +
        'if(typeof __oplog!=="undefined"&&__oplog.length<10000000){' +
        '__oplog.push("C47PRE: eg="+_$eg+" fK="+typeof _$fK+(typeof _$fK==="function"?"{"+String(_$fK).slice(0,90)+"}":(typeof _$fK==="object"?(" obj["+(function(){try{var __ks=[];for(var __k0 in _$fK){__ks.push(__k0);if(__ks.length>6)break;}return __ks.join(",");}catch(__z){return "E";}})()+"]"):"") )+" l6="+(typeof _$l6==="string"?_$l6:"t"+typeof _$l6)+" arg="+(typeof _$_m[_$bx]==="object"?"[o]":String(_$_m[_$bx]).slice(0,24)));try{var __ce0=_$fK.createElement;__oplog.push("C47CE: eg="+_$eg+" ce="+typeof __ce0+":"+String(__ce0).slice(0,60)+"|j7="+typeof __ce0._$j7+":"+String(__ce0._$j7).slice(0,50)+"|b3="+typeof __ce0._$b3);}catch(__ce1){}}' +
        'var __r47=_$fK[_$l6](_$_m[_$bx]);' +
        'if(typeof __oplog!=="undefined"&&__oplog.length<10000000){' +
        '__oplog.push("C47POST: eg="+_$eg+" ret="+(typeof __r47==="object"?("[o]"+(__r47&&__r47.length!==undefined?(" len"+__r47.length):(__r47&&__r47.constructor?(" ctor="+String(__r47.constructor).slice(0,50)):""))):String(__r47).slice(0,50)));}' +
        'return __r47;}catch(__e47){if(typeof __dbg!=="undefined")__dbg("OP47-EXC: "+String(__e47&&__e47.message||__e47)+" l6="+(function(){try{return typeof _$l6==="string"?_$l6:"t:"+typeof _$l6;}catch(__z){return "E";}})()+" fK="+typeof _$fK+" m="+typeof _$_m+" bx="+_$bx+" op="+(function(){try{return typeof _$_d;}catch(__z2){return "E";}})()+" eg="+(function(){try{return typeof _$eg;}catch(__z3){return "E";}})()+" m[bx]="+(function(){try{return typeof _$_m[_$bx];}catch(__z4){return "E";}})());throw __e47;}})())');
      logFn('[TRACE-TASK] op47 try-wrap probe injected');
    }
    if (c49 > 0) {
      code = code.replace(p49, () =>
        '_$bx=((function(){try{return _$_m[--_$lw]>_$bx;}catch(__e49){if(typeof __dbg!=="undefined")__dbg("OP49-EXC: "+String(__e49&&__e49.message||__e49)+" m="+typeof _$_m+" lw="+_$lw+" bx="+_$bx+" m2="+(function(){try{return typeof _$_m[_$lw];}catch(__y){return "E";}})());throw __e49;}})())');
      logFn('[TRACE-TASK] op49 try-wrap probe injected');
    }
  }
  let body = code;
  // ★ 逐 op 日志: 只注入执行器主循环 (p2/p3/tv 锚定, 结构唯一)
  //   真实循环: for(CUR=p2;CUR<p3;CUR++ ){OP=TASK.PROP[CUR];  (自增在 ) 前!)
  //   NO_OPLOG=1 时跳过 (验证插桩是否扰动 VM Proxy 状态)
  if (!process.env.NO_OPLOG) {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const loopRe = new RegExp(
      'for\\(([\\w$]+)=' + esc(p2) + ';\\1<' + esc(p3) + ';\\1\\+\\+\\s*\\)\\s*\\{' +
      '([\\w$]+)=' + esc(tv) + '\\[\\1\\];'
    );
    const searchFrom = body.indexOf(preamble);
    const lm = loopRe.exec(body.slice(searchFrom >= 0 ? searchFrom : 0));
    if (lm) {
      const absIdx = (searchFrom >= 0 ? searchFrom : 0) + lm.index;
      // 日志: POS:OP@SP:[栈顶4 trap-free]|b=操作数字节
      //   ★ trap-free: 只 typeof + 原语 String, 不碰对象 (Array.isArray/keys/slice/join 都会触发 Proxy 陷阱)
      const shSafe = '(function(__v){var __t=typeof __v;' +
        'if(__t==="object"){return __v===null?"null":"[o]";}' +
        'if(__t==="function"){try{return "[f]"+String(__v).slice(0,40);}catch(__e3){return "[f]";}}return String(__v);})';
      const topExpr =
        '(function(){var __r="";var __i=Math.max(0,' + cur + '-4);' +
        'for(;__i<' + cur + ';__i++){__r+=(""+' + shSafe + '(' + stk + '[__i])).slice(0,24)+";";}return __r;})()';
      const logStr =
        lm[1] + '+":"+' + lm[2] + '+"@"+' + cur + '+":"+' + topExpr + '+"|b="+' + tv + '[' + lm[1] + '+1]' +
        // GLOBAL[88] 直读 (op2 且 b=88 时)
        '+(' + lm[2] + '===2&&' + tv + '[' + lm[1] + '+1]===88?' + (slotNames.T_GLOBAL ? '(function(){try{var __g=' + slotNames.T_GLOBAL + '[88];var __r=":G88="+typeof __g+"|"+String(__g).slice(0,70)+"|ptype="+typeof __g.prototype+"|G73="+typeof ' + slotNames.T_GLOBAL + '[73]+"|"+String(' + slotNames.T_GLOBAL + '[73]).slice(0,50);if(typeof __g==="function"){__r+="|fid="+(__g===Function?"=F":(__g===Function.prototype.constructor?"=fpctor":"other"))+"|F="+String(Function).slice(0,40);}try{var __o=' + slotNames.T_GLOBAL + '[87];var __oc="?";try{var __oct=typeof __o.constructor;__oc=__oct+"|"+String(__o.constructor).slice(0,50)+"|eq="+(typeof __o.constructor==="function"?(__o.constructor===__g):"?");}catch(__e0){__oc="E";}__r+="|O87="+(typeof __o)+"|"+String(__o).slice(0,40)+"|O87ctor="+__oc;}catch(__e1){__r+="|O87ERR";}return __r;}catch(__e2){return ":G88ERR";}})()' : '""') + (slotNames.T_GLOBAL ? ' : "")' : ')') +
        // T1621 probe: 34@1 dumps read obj + Function.prototype.toString state
        '+((typeof __taskNo!=="undefined"&&__taskNo===1627)?'
        + '(function(){try{var __o1621=' + stk + '[' + cur + '-1];var __o0=' + stk + '[' + cur + '-2];'
        + 'var __r=":T1621:p="+' + lm[2] + '+":"+' + cur + '+":t="+__taskNo+":v="+(typeof __o1621==="function"?String(__o1621).slice(0,42):typeof __o1621);'
        + '__r+=":vF="+(__o1621===Function)+":vFctor="+(__o1621===Function.prototype.constructor);'
        + '__r+=":FpttF="+(Function.prototype.toString===Function)+":FpttFctor="+(Function.prototype.toString===Function.prototype.constructor)+":Fptt="+String(Function.prototype.toString).slice(0,40);'
        + '__r+=":ownT="+(Object.prototype.hasOwnProperty.call(__o0,"toString"))+":protoF="+(Object.getPrototypeOf(__o0)===Function.prototype);'
        + 'return __r;}catch(__e){return ":T1621ERR:"+String(__e&&__e.message).slice(0,80)+":p="+' + lm[2] + '+":"+' + cur + '+":t="+(typeof __taskNo!=="undefined"?__taskNo:"undef");}})()'
        + ' : ' + '\"\"' + ')' +
        // Task 0-40 区域 op49@3: dump A 身份 (A=34产物, 49@3 前栈 [G88,A,'constructor'] → A=stk[cur-2])
        '+(' + p2 + '===0&&' + p3 + '===40&&' + lm[2] + '===49&&' + cur + '===3?' + (slotNames.T_GLOBAL ? '(function(){try{var __a=' + stk + '[' + cur + '-2];var __g=' + slotNames.T_GLOBAL + '[88];var __r=":A49="+(__a===__g)+":A="+String(__a).slice(0,45)+":Actor="+(__a&&typeof __a.constructor==="function"?String(__a.constructor).slice(0,45):"none")+":AeqG="+(__a&&__a.constructor===__g)+":Aproto="+(__a&&__a.__proto__===__g.prototype)+":Aptor="+(__a&&typeof __a.prototype!=="undefined"&&__a.prototype&&__a.prototype.constructor===__g);return __r;}catch(__e){return ":A49ERR";}})()' : '""') + ':"")' +
        // Task 0-40 区域 op2(b=85): dump GLOBAL[85] 身份 (Task 1622 的 B 对象)
        // op2(b=85): dump GLOBAL/T_8/T_V/T_GW 四表[85] 身份 (定位 op2 压栈源 — 分叉: N=Request原生 S=_$_O)
        '+(' + lm[2] + '===2&&' + tv + '[' + lm[1] + '+1]===85?' + (slotNames.T_GLOBAL ? '(function(){try{var __r85=":G85x=";var __o85=' + slotNames.T_GLOBAL + '[85];__r85+="G="+typeof __o85+"|len="+(__o85&&__o85.slice?__o85.length:"-")+"|"+String(__o85).slice(0,200);' + (slotNames.T_8 ? 'try{var __e85=' + slotNames.T_8 + '[85];__r85+="|T8="+typeof __e85+"|"+String(__e85).slice(0,45);}catch(__e8){__r85+="|T8E";}' : '') + (slotNames.T_V ? 'try{var __f85=' + slotNames.T_V + '[85];__r85+="|TV="+typeof __f85+"|"+String(__f85).slice(0,45);}catch(__e9){__r85+="|TVE";}' : '') + (slotNames.T_GW ? 'try{var __g85=' + slotNames.T_GW + '[85];__r85+="|GW="+typeof __g85+"|"+String(__g85).slice(0,45);}catch(__eA){__r85+="|GWE";}' : '') + 'try{var __h85=' + tv + '[' + lm[1] + '+1];__r85+="|b="+typeof __h85+"|"+String(__h85).slice(0,20);}catch(__eB){__r85+="|bE";}try{var __s85=' + stk + '[' + cur + '-1];__r85+="|top="+typeof __s85+"|"+String(__s85).slice(0,45);}catch(__eC){__r85+="|topE";}' +
        // ★ 2026-08-19: G 表槽位内容 dump (16-136 分叉: N=G43 len4 vs S=len2) — [43]/[81]/[57]/[140]
        'try{var __g43=' + slotNames.T_GLOBAL + '[85][43];__r85+="|G43="+typeof __g43+"|len"+(__g43&&__g43.slice?__g43.length:"-")+"|"+String(__g43).slice(0,90);}catch(__e43){__r85+="|G43E";}' +
        'try{var __g81=' + slotNames.T_GLOBAL + '[85][81];__r85+="|G81="+typeof __g81+"|len"+(__g81&&__g81.slice?__g81.length:"-")+"|"+String(__g81).slice(0,90);}catch(__e81){__r85+="|G81E";}' +
        'try{var __g57=' + slotNames.T_GLOBAL + '[85][57];__r85+="|G57="+typeof __g57+"|"+String(__g57).slice(0,60);}catch(__e57){__r85+="|G57E";}' +
        'try{var __g140=' + slotNames.T_GLOBAL + '[85][140];__r85+="|G140="+typeof __g140+"|"+String(__g140).slice(0,60);}catch(__e140){__r85+="|G140E";}' +
        'return __r85;}catch(__e85){return ":G85xERR";}})()' : '""') + ':"")' +
        // Task 0-40 区域 op4(b=87): dump GLOBAL[87] 身份 (Task 1622 的 C 对象)
        '+(' + p2 + '===0&&' + p3 + '===40&&' + lm[2] + '===4&&' + tv + '[' + lm[1] + '+1]===87?' + (slotNames.T_GLOBAL ? '(function(){try{var __o4=' + slotNames.T_GLOBAL + '[87];var __g4=' + slotNames.T_GLOBAL + '[88];var __r4=":O87="+typeof __o4+"|"+String(__o4).slice(0,50);if(__o4&&typeof __o4.constructor==="function"){__r4+="|ctor="+String(__o4.constructor).slice(0,60)+"|eq88="+(__o4.constructor===__g4);}return __r4;}catch(__e4){return ":O87ERR";}})()' : '""') + ':"")' +
        // Task 0-40 区域 op34: dump 栈顶(接收者)与 G88 关系
        '+(' + p2 + '===0&&' + p3 + '===40&&' + lm[2] + '===34?' + (slotNames.T_GLOBAL ? '(function(){try{return ":34eq88="+(' + stk + '[' + cur + '-1]===' + slotNames.T_GLOBAL + '[88])+":34v="+String(' + stk + '[' + cur + '-1]).slice(0,50);}catch(__e34){return ":34ERR";}})()' : '""') + ':"")' +
        // 5-530 任务区域: 记录 BYTES[61] + op51 存储值 (栈顶)
        '+(' + p2 + '===5&&' + p3 + '===530?":B61="+' + tv + '[61]+"|B28="+' + tv + '[28]+"|lw="+_$lw+"|S27="+' + tv + '[27]+"|S28="+' + tv + '[28]+"|S62="+' + tv + '[62]+"|S63="+' + tv + '[63]+"|S86="+' + tv + '[86]+"|S87="+' + tv + '[87]+"|S98="+' + tv + '[98]+"|S99="+' + tv + '[99]:"")' +
        '+(' + p2 + '===5&&' + p3 + '===530&&' + lm[2] + '===51?":S51="+typeof ' + stk + '[' + cur + '-1]:"")' +
        // 5-530 全行: 记录 _$fK/_$l6 (方法接收者/方法名)
        '+(' + p2 + '===5&&' + p3 + '===530?(function(){var __f=typeof _$fK,f;try{f=typeof _$fK==="string"?_$fK:(typeof _$fK==="function"?"fn":(typeof _$fK==="number"?("n"+_$fK):("t"+__f)));}catch(__z){f="E";}var __l=typeof _$l6,l;try{l=typeof _$l6==="string"?_$l6:(typeof _$l6==="number"?("n"+_$l6):(typeof _$l6==="function"?"fn":"t"+__l));}catch(__z2){l="E";}return ":FK="+f+"|L6="+l;})():"")' +
        // op82 (for-in): dump 被遍历对象的首/尾键 + 构造器名 + 是否==VM全局window (识别收集器的遍历源)
        '+(' + lm[2] + '===82?(function(){try{var __o82=' + stk + '[' + cur + '-1];var __c82="?";try{__c82=__o82===null?"null":(__o82&&__o82.constructor?String(__o82.constructor.name||__o82.constructor).slice(0,25):typeof __o82);}catch(__e82b){__c82="E:"+typeof __o82;}var __pw82="?";try{__pw82=(function(){var __pr=Object.getPrototypeOf(__o82);return __pr===null?"null":(__pr&&__pr.constructor?String(__pr.constructor.name||__pr.constructor).slice(0,20):typeof __pr);})();}catch(__e82p){__pw82="E";}var __fk82=[];for(var __k82 in __o82){__fk82.push(__k82);}var __w82="?";try{__w82=(__o82===window)?"Y":"N";}catch(__e82w){__w82="E";}var __g82="?";try{__g82=(__o82===globalThis)?"Y":"N";}catch(__e82g){__g82="E";}var __rd82=__fk82.indexOf("removeEventListener")>=0?"R":"-";var __head20=__fk82.slice(0,20).join("|");var __tail20=__fk82.slice(-20).join("|");if(__fk82.length>40||__w82==="Y"){try{typeof __f82dump!=="undefined"&&__f82dump.push([__fk82.length,__c82,__pw82,__w82,__g82,__rd82,__head20,__tail20]);}catch(__e82d){}}var __sdD82="?";try{var __sd8=Object.getOwnPropertyDescriptor(__o82,"_sdGlobalObject");__sdD82=__sd8?("sdE"+(__sd8.enumerable?"T":"F")+",v"+(typeof __sd8.value)+",w"+(__sd8.writable?"T":"F")):"sdNONE";}catch(__eS82){__sdD82="sdE:"+String(__eS82&&__eS82.message).slice(0,20);}var __isC82="?";try{__isC82=(__o82===this)?"THIS":"no";}catch(__eT82){__isC82="E";}return ":F82["+__fk82.length+","+__c82+",pw="+__pw82+",w="+__w82+","+__fk82.slice(0,3).join(",")+".."+__fk82.slice(-3).join(",")+"]["+__sdD82+"|eqThis="+__isC82+"]";}catch(__e82){return ":F82ERR";}})():"")' +
        // ★ 2026-09-01: op2 b=81 → dump _$$H[81] (0-106 cookie 接收者) 身份
        '+(' + lm[2] + '===2&&' + tv + '[' + lm[1] + '+1]===81?' + (slotNames.H2 ? '(function(){try{var __h81=' + slotNames.H2 + '[81];var __r=":H81[";try{__r+="eqDoc="+(typeof document!=="undefined"&&__h81===document)+";eqWin="+(typeof window!=="undefined"&&__h81===window)+";";}catch(e){}try{__r+="ctor="+String(__h81&&__h81.constructor).slice(0,40)+";";}catch(e){}try{__r+="t="+typeof __h81+";";}catch(e){}return __r+"]";}catch(__e){return ":H81ERR";}})()' : '":H81-noslot"') + ':"")' +
        // ★ 2026-09-01: op51 → dump 写目标 stk[cur-3] 身份 + ACC 寄存器身份 (0-106 cookie 写入分叉)
        '+(' + lm[2] + '===51?(function(){try{var __t51=' + stk + '[' + cur + '-3];var __r=":O51TGT[";try{__r+="eqDoc="+(typeof document!=="undefined"&&__t51===document)+";eqWin="+(typeof window!=="undefined"&&__t51===window)+";eqts="+(typeof window!=="undefined"&&typeof window["$_ts"]!=="undefined"&&__t51===window["$_ts"])+";";}catch(e){}try{__r+="ctor="+String(__t51&&__t51.constructor).slice(0,40)+";";}catch(e){}try{__r+="t="+typeof __t51+";";}catch(e){}' + (slotNames.ACC ? 'try{var __a51=' + slotNames.ACC + ';__r+="ACCeqDoc="+(typeof document!=="undefined"&&__a51===document)+";ACCctor="+String(__a51&&__a51.constructor).slice(0,40)+";ACCt="+typeof __a51+";MS="+String(' + slotNames.MS + ').slice(0,20)+";";}catch(e){__r+="ACCE";}' : '') + 'return __r+"]";}catch(__e){return ":O51TGTER";}})():"")' +
        // 写指令探测: op51/22/106 属性赋值时判断目标是否==tv(字节码数组)/stk
        '+(' + lm[2] + '===51||' + lm[2] + '===22||' + lm[2] + '===106?(function(){try{return ":W=("+(typeof _$fK==="object"?(_$fK===' + tv + '?"TV":(_$fK===' + stk + '?"STK":"OBJ")):typeof _$fK)+(typeof _$fK==="function"?":F="+String(_$fK).slice(0,60):"")+",l6="+(typeof _$l6==="string"?_$l6:(typeof _$l6==="number"?("n"+_$l6):typeof _$l6))+",bx="+(typeof _$bx==="number"?_$bx:(typeof _$bx==="string"?(\'"\'+_$bx.slice(0,14)+\'"\'):typeof _$bx))+")";}catch(__w){return ":WERR";}})():"")' +
        // 0-140 任务 op51 调用后: dump [o]=p4[0] 演化 (找 213/182 写入点)
        '+(' + p2 + '===0&&' + p3 + '===140&&(' + lm[2] + '===51||' + lm[2] + '===61||' + lm[2] + '===49)?(function(){try{var __d49="";if(' + lm[2] + '===49){try{var __o49=' + stk + '[' + cur + '-1];var __o49b=' + stk + '[' + cur + '-2];var __id49="OBJ";if(typeof __o49b==="object"&&__o49b){if(__o49b===_$ii)__id49="=ii";else if(__o49b===_$ga)__id49="=ga";else if(__o49b===_$hZ)__id49="=hZ";else if(typeof __o49b.slice==="function")__id49="a"+__o49b.length;}var __rv49="ERR";try{var __v49=__o49b[__o49];__rv49=typeof __v49==="number"?("n"+__v49):(typeof __v49==="object"&&__v49&&typeof __v49.slice==="function"?("a"+__v49.length):String(__v49).slice(0,10));}catch(__e49x){}__d49="[P49 "+__id49+" i"+(typeof __o49==="number"?"n"+__o49:typeof __o49)+" v"+__rv49+"]";}catch(__e49y){}}var __bc61="";if(' + lm[2] + '===61){try{var __bc61a=[];for(var __i61=0;__i61<45;__i61++)__bc61a.push(' + tv + '[__i61]);var __g197=_$ii[197];var __g2=_$ii[2];var __ga0=_$ga[0];__bc61="[BC"+__bc61a.join(",")+"][G197"+(typeof __g197==="function"?__g197.toString().slice(0,800).replace(/\\n/g," "):typeof __g197)+"][G2"+(typeof __g2==="object"&&__g2&&__g2.slice?("a"+__g2.length):typeof __g2)+"][ga0"+(typeof __ga0==="object"&&__ga0&&__ga0.slice?("a"+__ga0.length):typeof __ga0)+"][g2eqga0="+(_$ii[2]===_$ga[0])+"]";}catch(__e61b){__bc61="[BCERR]";}}var __o51=' + p4 + '[0];var __h51=[];for(var __i51=0;__i51<Math.min(__o51.length,12);__i51++){var __v51=__o51[__i51];__h51.push(typeof __v51==="number"?("n"+__v51):(typeof __v51==="string"?("s"+__v51.slice(0,10)):(typeof __v51==="object"&&__v51&&__v51.slice)?("a"+__v51.length):"[o]"));}var __g63=_$g8[63];var __he51=typeof _$hE==="object"?(_$hE===_$hZ?"=p4":(_$hE===_$ii?"=ii":(_$hE===_$g8?"=g8":"OBJ"))):typeof _$hE;var __d51=0;try{__d51=_$i2[_$oQ-1];}catch(__e51d){}return __d49+__bc61+"[O51["+__o51.length+"]="+__h51.join(",")+"][G63"+(typeof __g63==="string"?("s"+__g63.slice(0,16)):(typeof __g63==="object"&&__g63&&__g63.slice)?("a"+__g63.length):typeof __g63)+"][HE"+__he51+",lu"+(typeof _$lu==="number"?("n"+_$lu):typeof _$lu)+",stkTop"+(typeof __d51==="object"&&__d51&&__d51.slice?("a"+__d51.length):(typeof __d51==="number"?("n"+__d51):typeof __d51))+"][NT"+(typeof _$nT==="function"?_$nT.toString().slice(0,2400).replace(/\\n/g," "):typeof _$nT)+"]";}catch(__e51o){return "[O51ERR]";}})():"")' +
        // op116 (按位或): dump 执行前两个操作数 (定位 [213]/[182] 来源)
        '+(' + lm[2] + '===116?(function(){try{return ":O116[a="+(function(__v){var __t=typeof __v;if(__t==="object"){if(__v&&__v.slice)return "arr["+__v.length+"]="+String(__v[0]).slice(0,15)+","+String(__v[1]).slice(0,15)+","+String(__v[2]).slice(0,15);return "[o]";}if(__t==="function")return "[f]";return String(__v);})(' + stk + '[' + cur + '-2])+") b="+(function(__v){var __t=typeof __v;if(__t==="object"){if(__v&&__v.slice)return "arr["+__v.length+"]="+String(__v[0]).slice(0,15);return "[o]";}return String(__v);})(' + stk + '[' + cur + '-1])+")]";}catch(__e116){return ":O116ERR";}})():"")' +
        // op76: dump 操作数 ([o] 对象 keys) — 64-209 任务 107:1 分叉 (sdenv 3 vs nodenv 14) 来源定位
        '+(' + lm[2] + '===76?(function(){try{var __o76=' + stk + '[' + cur + '-1];var __ks76=[];try{for(var __k76 in __o76){__ks76.push(__k76);if(__ks76.length>12)break;}}catch(e76){__ks76.push("!iter");}return ":O76["+(typeof __o76)+( __o76&&__o76.slice?"arr"+__o76.length:"")+"]ks="+__ks76.join(",")+"|s1="+String(' + stk + '[' + cur + '-1]).slice(0,30)+"|s2="+String(' + stk + '[' + cur + '-2]).slice(0,30);}catch(__e76){return ":O76-ERR";}})():"")' +
        // ★ 2026-08-31: op49 读 'length'/'tagName'/'nodeName' → dump 被读对象身份 (全任务; 不设计数器避免污染 window for-in)
        '+(' + lm[2] + '===49?(function(){try{var __k=' + stk + '[' + cur + '-1];if(typeof __k==="string"&&(__k==="length"||__k==="tagName"||__k==="nodeName")){var __o=' + stk + '[' + cur + '-2];var __r=":O49LEN[k="+__k+"|t="+typeof __o+";";try{__r+="ctor="+String(__o&&__o.constructor).slice(0,45)+";";}catch(e){}try{__r+="len="+__o.length+";";}catch(e){__r+="lenE;";}try{__r+="tag="+(__o&&__o.tagName||"-")+";name="+(__o&&__o.nodeName||"-")+";";}catch(e){}try{__r+="eqDoc="+(__o===document)+";eqWin="+(__o===window)+";";}catch(e){}try{__r+="item="+typeof __o.item+";slice="+typeof __o.slice+";";}catch(e){}try{var __ks=[];for(var __kk in __o){__ks.push(__kk);if(__ks.length>8)break;}__r+="ks="+__ks.join(",");}catch(e){__r+="ksE;";}return __r+"]";}return "";}catch(__e){return ":O49LENER";}})():"")' +
        // ★ 2026-08-31: op37 (ACC=ACC[KEY]; push ACC()) → dump ACC (栈顶-1) 身份 (15-31 ActiveXObject 检测)
        '+(' + lm[2] + '===37?(function(){try{var __a=' + stk + '[' + cur + '-1];var __r=":O37ACC[t="+typeof __a+"|"+String(__a).slice(0,60)+"]";return __r;}catch(__e){return ":O37ACCER";}})():"")' +
        // ★ 2026-08-31: op12 (push hV[byte]) → dump hV[操作数] (Canvas getImageData 缺失源)
        '+(' + lm[2] + '===12&&typeof ' + (slotNames.HV || 'null') + '!=="undefined"?(function(){try{var __hi=' + tv + '[' + lm[1] + '+1];var __hv=' + slotNames.HV + '[__hi];var __r=":H12[i="+__hi+"|t="+typeof __hv+"|"+String(__hv).slice(0,50)+"]";try{if(typeof __o27==="undefined"){try{__o27=(typeof window!=="undefined")?window.__o27:[];}catch(e){__o27=[];}}if(__o27.length<20000)__o27.push(__r);}catch(e){}return __r;}catch(__e){return ":H12ER";}})():"")' +
        // ★ 2026-09-01: op2 b=71 → dump G[71] (T_T 数字表) 前 100 元素 — 0-42 读 G71[31]/[42] 分叉源
        // ★ 2026-09-01: op2 b=71 场景 — dump jb[1][3][30] (0-42 跳转条件)
        '+(' + lm[2] + '===2&&' + tv + '[' + lm[1] + '+1]===71?(function(){try{var __r2=":JB30[";try{var __j3=' + (slotNames.JB || 'null') + '[1][3];__r2+="t="+typeof __j3+";v30="+String(__j3[30])+";len="+String(__j3.length)+";";}catch(e){__r2+="E:"+String(e).slice(0,30);}return __r2+"]";}catch(__e){return ":JB30ER";}})():"")' +
        // ★ 2026-09-01: op47 (调用 ACC[KEY](arg)) → dump 寄存器被调函数 (0-7 轮询周期驱动源)
        '+(' + lm[2] + '===47?(function(){try{var __r=":O47F2[";try{var __oz=' + (slotNames.ACC || 'null') + ';var __ms=' + (slotNames.MS || 'null') + ';var __fn=__oz[__ms];__r+="oz="+typeof __oz+"|k="+String(__ms)+"|fn="+typeof __fn+";str="+String(__fn).slice(0,60)+";";}catch(e){__r+="E:"+String(e).slice(0,40);}return __r+"]";}catch(__e){return ":O47F2ER";}})():"")' +
        '+(' + lm[2] + '===2&&' + tv + '[' + lm[1] + '+1]===71?(function(){try{var __g=' + slotNames.T_GLOBAL + '[71];var __r=":G71[";if(__g&&__g.slice){for(var __i=0;__i<Math.min(__g.length,60);__i++){__r+=__g[__i];if(__i<59&&__i<__g.length-1)__r+=",";}}__r+="]";try{if(typeof __g71d==="undefined"){try{__g71d=(typeof window!=="undefined")?window.__g71d:[];}catch(e){__g71d=[];}}if(__g71d.length<10)__g71d.push(__r);}catch(e){}return __r;}catch(__e){return ":G71ER";}})():"")' +
        // ★ 2026-08-31: op19 调用 → dump 被调函数 (全任务)
        '+(' + lm[2] + '===19?(function(){try{var __f=' + stk + '[' + cur + '-1];if(typeof __f==="function"){var __r=":O19CALL[";try{__r+="fn="+String(__f).slice(0,90).replace(/\\n/g," ")+";";}catch(e){__r+="fnE;";}try{__r+="eqDCE="+(typeof document!=="undefined"&&__f===document.createElement)+";";}catch(e){}try{__r+="name="+(__f.name||"-")+";";}catch(e){}return __r+"]";}return "";}catch(__e){return ":O19CALLER";}})():"")' +
        // ★ 2026-08-31: 0-306 任务 op32 (Object.getOwnPropertyDescriptor 调用) → dump 目标对象 X + G[77]
        '+(' + p2 + '===0&&' + p3 + '===306&&' + lm[2] + '===32?(function(){try{var __x=' + stk + '[' + cur + '-2];var __r=":O32WBD[";try{__r+="t="+typeof __x+";ctor="+String(__x&&__x.constructor).slice(0,50)+";";}catch(e){}try{__r+="wd="+(Object.prototype.hasOwnProperty.call(__x,"webdriver")?"OWN":"no-own")+";";}catch(e){}try{__r+="eqWin="+(__x===window)+";eqNav="+(__x===navigator)+";eqDoc="+(__x===document)+";";}catch(e){}try{__r+="eqG77="+(' + slotNames.T_GLOBAL + '?__x===' + slotNames.T_GLOBAL + '[77]:"na")+";";}catch(e){}try{var __g77=' + slotNames.T_GLOBAL + '[77];__r+="G77="+typeof __g77+"|"+String(__g77).slice(0,60)+";";}catch(e){}try{var __ks=[];for(var __kk in __x){__ks.push(__kk);if(__ks.length>6)break;}__r+="ks="+__ks.join(",");}catch(e){}return __r+"]";}catch(__e){return ":O32WBDER";}})():"")' +
        // ★ 2026-08-31: op49 读 'matchMedia' (全任务) → dump 被读对象身份 (任务号每轮随机, 不能硬编码)
        '+(' + lm[2] + '===49?(function(){try{var __k=' + stk + '[' + cur + '-1];if(typeof __k==="string"&&__k==="matchMedia"){var __o=' + stk + '[' + cur + '-2];if(typeof __o!=="string"){var __r=":O49MM[";try{__r+="eqWin="+(__o===window)+";t="+typeof __o+";ctor="+String(__o&&__o.constructor).slice(0,60)+";";}catch(e){}try{var __ks=[];for(var __kk in __o){__ks.push(__kk);if(__ks.length>5)break;}__r+="ks="+__ks.join(",");}catch(e){}return __r+"]";}}return "";}catch(__e){return ":O49MMER";}})():"")' +
        // op61 无条件: dump 编码输入 (cookie 值构建源!) 完整内容 + 模拟 _$d8 解析 (对象/方法)
        '+(' + lm[2] + '===61?(function(){try{var __e61in=' + stk + '[' + cur + '-1];var __e61s=[];for(var __e61i=0;__e61i<Math.min((__e61in&&__e61in.length)||0,280);__e61i++){var __e61v=__e61in[__e61i];__e61s.push(typeof __e61v==="number"?("n"+__e61v):(typeof __e61v==="string"?("s"+__e61v.slice(0,6)):(typeof __e61v==="object"&&__e61v&&__e61v.slice?("a"+__e61v.length):(typeof __e61v))));}var __d8r="[D8BEG]";try{var __p61c=' + lm[1] + ';var __o61=' + tv + '[__p61c+1];var __eE61,__pZ61;if(__o61<=13){if(__o61<=3){__eE61=' + tv + '[__p61c+2];__pZ61=' + p4 + '[2];}else if(__o61<=9){__pZ61=' + p4 + '[3][' + tv + '[__p61c+2]];__eE61=' + tv + '[__p61c+3];}else{__eE61=_$gZ[' + tv + '[__p61c+2]];__pZ61=' + stk + '[' + cur + '-2];}}else if(__o61<=41){if(__o61<=24){__eE61=' + tv + '[__p61c+2];__pZ61=' + p4 + '[0];}else if(__o61<=33){__eE61=' + tv + '[__p61c+2];__pZ61=_$hp;}else if(__o61<=35){__eE61=' + tv + '[__p61c+2];__pZ61=_$d2;}else{__eE61=' + stk + '[' + cur + '-2];__pZ61=' + stk + '[' + cur + '-3];}}else if(__o61<=70){__pZ61=' + stk + ';__eE61=' + cur + '-2;}else if(__o61<=98){__eE61=' + tv + '[__p61c+2];__pZ61=' + stk + '[' + cur + '-2];}else{__pZ61=' + p4 + '[1][' + tv + '[__p61c+2]];__eE61=' + tv + '[__p61c+3];}var __m61;try{__m61=__pZ61[__eE61];}catch(__m1){__m61="ERR";}var __r61="RERR";try{__r61=__m61(__e61in);}catch(__r1){__r61="RERR:"+String(__r1&&__r1.message||__r1).slice(0,30);}__d8r="[D8OK]"+("[D8 o1="+__o61+" eE="+(typeof __eE61==="string"?("s"+__eE61.slice(0,20)):(typeof __eE61==="number"?("n"+__eE61):typeof __eE61))+" pZ="+(typeof __pZ61==="object"?(__pZ61===' + stk + '?"=stk":(typeof _$ii!=="undefined"&&__pZ61===_$ii?"=ii":(typeof _$ga!=="undefined"&&__pZ61===_$ga?"=ga":(typeof __pZ61.slice==="function"?("a"+__pZ61.length):"[o]")))):(typeof __pZ61==="function"?"fn":String(__pZ61).slice(0,20)))+" M="+(typeof __m61==="function"?("fn"+__m61.toString().slice(0,4000).replace(/\\n/g," ")):(typeof __m61==="string"?("s"+__m61.slice(0,20)):typeof __m61))+("|HR4="+(typeof _$hr==="object"?(_$hr&&_$hr.slice?(_$hr[4]+","+_$hr[41]+","+_$hr[42]+","+_$hr[52]+","+_$hr[53]+","+_$hr[51]):"noslice"):typeof _$hr))+"|BD="+(typeof _$bd==="object"?String(_$bd[42])+","+String(_$bd[43])+","+String(_$bd[45]):typeof _$bd))+("|ALPH="+(typeof _$b7==="string"?_$b7.slice(0,200):(typeof _$b7==="object"?String(_$b7).slice(0,200):typeof _$b7)))+("|HRALL="+(typeof _$hr==="object"&&_$hr&&_$hr.slice?(function(){var __a=[];for(var __i=0;__i<_$hr.length&&__i<80;__i++){__a.push(_$hr[__i]);}return __a.join(",");})():"no"))+("|BDALL="+(typeof _$bd==="object"&&_$bd&&_$bd.slice?(function(){var __b=[];for(var __j=0;__j<_$bd.length&&__j<60;__j++){__b.push(String(_$bd[__j]));}return __b.join(",");})():"no"))+("|O6="+(typeof _$o6==="function"?("fn"+_$o6.toString().slice(0,1500).replace(/\\n/g," ")):(typeof _$o6==="string"?("s"+_$o6.slice(0,100)):typeof _$o6)))+("|EG="+(typeof _$eG==="undefined"?"undef":(typeof _$eG==="number"?("n"+_$eG):(typeof _$eG==="string"?("s"+_$eG.slice(0,20)):typeof _$eG))))+("|HR1="+(typeof _$hr==="object"&&_$hr?String(_$hr[1]):"no"))+("|BD10="+(typeof _$bd==="object"&&_$bd?String(_$bd[10]):"no"))+("|HE="+(typeof _$hE==="function"?("fn"+_$hE.toString().slice(0,300)):typeof _$hE))+("|AO22="+(typeof _$ao==="object"&&_$ao?(_$ao[22]&&_$ao[22].toString?("fn"+_$ao[22].toString().slice(0,120)):String(_$ao[22])):typeof _$ao))+("|AO10="+(typeof _$ao==="object"&&_$ao?(_$ao[10]&&_$ao[10].toString?("fn"+_$ao[10].toString().slice(0,120)):String(_$ao[10])):typeof _$ao))+("|AO16="+(typeof _$ao==="object"&&_$ao?(_$ao[16]&&_$ao[16].toString?("fn"+_$ao[16].toString().slice(0,120)):String(_$ao[16])):typeof _$ao))+("|B7ALL="+(typeof _$b7==="string"?_$b7:(typeof _$b7==="object"?String(_$b7):typeof _$b7)))+("|R="+(typeof __r61==="string"?__r61.slice(0,600):(typeof __r61==="object"&&__r61&&__r61.slice?("a"+__r61.length):String(__r61).slice(0,100))));}catch(__d8e){__d8r="[D8ERR:"+String(__d8e&&__d8e.message||__d8e).slice(0,40)+"]";}return ":E61[L"+((__e61in&&__e61in.length)||(typeof __e61in==="string"?__e61in.length:typeof __e61in))+"]["+__e61s.join(",")+"][b="+String(' + stk + '[' + cur + '-2]).slice(0,30)+"]"+__d8r;;}catch(__e61z){return ":E61ERR";}})():"")' +
        // ★ 2026-09-01: op60 (ACC[mS]++) → dump ACC===jb[3]? + mS + 递增前值 (jb[3][2] 轮次计数器分叉源)
        '+(' + lm[2] + '===60?' + (slotNames.JB && slotNames.ACC && slotNames.MS ? '(function(){try{return ":JBINC[eq3="+(' + slotNames.ACC + '===' + slotNames.JB + '[3])+";ms="+String(' + slotNames.MS + ')+";val="+String(' + slotNames.ACC + '[' + slotNames.MS + ']).slice(0,12)+";ct="+(typeof window!=="undefined"&&typeof window.__curtask!=="undefined"?window.__curtask:"?");}catch(__e){return ":JBINCE:"+String(__e).slice(0,40);}})()' : '":JBINC-noslot"') + ':"")';
      // ★ 2026-08-19: 16-136 任务全字节码 dump (op4 压入 4/2 差异 — tv 内容两侧不同假设)
      //   注意: 必须以分号开头 (不以 + 开头 — 一元正号会把 try 吞进表达式导致 SyntaxError)
      const bcProbe16 = ';(' + p2 + '===16&&' + p3 + '===136?(function(){try{var __bc=[];for(var __i=0;__i<' + tv + '.length&&__i<150;__i++){__bc.push(' + tv + '[__i]);}typeof __oplog!=="undefined"&&__oplog.length<10000000?__oplog.push(":BC["+__bc.join(",")+"]"):0;return "";}catch(__e){typeof __oplog!=="undefined"?__oplog.push(":BCERR:"+String(__e&&__e.message).slice(0,30)):0;return "";}})():"")';
      const inj = lm[0] + bcProbe16 + ';' +
        'try{typeof __oplog!=="undefined"&&__oplog.length<10000000?__oplog.push(' + logStr + '):0;}catch(__oe){}';
      body = body.slice(0, absIdx) + inj + body.slice(absIdx + lm[0].length);
      logFn('[TRACE-TASK] oplog injected (executor loop, p2/p3/tv anchored)');
      // ★ MF 探针 (必须在循环注入后做, 否则 absIdx 偏移错位): dump _$ii[197] (_$mf, 30字符串→1364数组 解码器) 输入/输出
      let mfIdx = body.indexOf('function _$mf(_$pR){');
      if (mfIdx >= 0) {
        const mfRet = body.indexOf('return _$k7;', mfIdx);
        if (mfRet >= 0) {
          const mfOut = 'var __ro=_$k7;try{typeof __oplog!=="undefined"?__oplog.push("MF_OUT["+__ro.length+"|"+__ro[0]+","+__ro[1]+","+__ro[2]+","+__ro[3]+","+__ro[4]+","+__ro[5]+"][TBL"+(typeof _$e$)+","+(typeof _$ow)+","+(typeof _$cK)+","+(typeof _$e6)+","+(typeof _$_7)+","+(typeof _$f0)+"][e0="+String(_$e$).slice(0,6)+"][o0="+String(_$ow).slice(0,6)+"][c0="+String(_$cK).slice(0,6)+"][e60="+String(_$e6).slice(0,6)+"][70="+String(_$_7).slice(0,6)+"][f0="+String(_$f0).slice(0,6)+"][R42="+_$$r[42]+"][R4="+_$$r[4]+"][dT4="+typeof _$dT[4]+"][k943="+_$k9[43]+"]"):0;}catch(__e){}return __ro;';
          body = body.slice(0, mfRet) + mfOut + body.slice(mfRet + 'return _$k7;'.length);
          const mfHdr = 'function _$mf(_$pR){';
          const mfIn = 'try{typeof __oplog!=="undefined"?__oplog.push("MF_IN["+_$pR+"][L"+_$pR.length+"][T"+typeof _$pR+"]"):0;}catch(__e){}';
          body = body.slice(0, mfIdx + mfHdr.length) + mfIn + body.slice(mfIdx + mfHdr.length);
          logFn('[TRACE-TASK] MF probe installed (idx=' + mfIdx + ')');
        }
      }
      // ★ FV 探针 (名字无关): 两参函数 + var 后 p2=TRANS(p2) 密钥转换特征 = Feistel 加密函数
      //   唯一匹配 (实测每轮 KEYTRANS 只 1 个: _$lW/_$fv 等价物), 明文 = 加密前数据 (cookie 明文!)
      const fvRe2 = /function (_\$\w+)\(([\$\w]+),([\$\w]+)\)\{var ([^;]+);\3=([\$\w]+)\(\3\)/;
      const fvM = fvRe2.exec(body);
      if (fvM) {
        const fvFn = fvM[1], fvP1 = fvM[2], fvP2 = fvM[3];
        const fvBrace = body.indexOf('{', fvM.index) + 1;  // 函数头 { 之后 (fvM[0] 覆盖到 p2=F(p2), 不能插末尾!)
        const fvIn = 'try{typeof __oplog!=="undefined"?__oplog.push("FV_IN[L"+(typeof ' + fvP1 + '==="string"?' + fvP1 + '.length:(' + fvP1 + '&&' + fvP1 + '.length))+"][T"+typeof ' + fvP1 + '+"][K"+String(' + fvP2 + ').slice(0,20)+"][D"+String(' + fvP1 + ').slice(0,2000)+"]"):0;}catch(__e){}';
        body = body.slice(0, fvBrace) + fvIn + body.slice(fvBrace);
        // ★ FV_OUT: 在 Feistel return 处 dump 加密输出 (对比 cookie 257B 密文与 Feistel 输出长度!)
        const fvRet = body.indexOf('return ', fvBrace);
        if (fvRet >= 0) {
          const fvOut = 'try{typeof __oplog!=="undefined"?__oplog.push("FV_OUT[L"+(typeof _$h8==="string"?_$h8.length:(_$h8&&_$h8.length))+"][D"+String(_$mm(_$h8)).slice(0,3000)+"]"):0;}catch(__e){}';
          body = body.slice(0, fvRet) + fvOut + body.slice(fvRet);
          logFn('[TRACE-TASK] FV_OUT probe installed (ret idx=' + fvRet + ')');
        }
        logFn('[TRACE-TASK] FV probe (struct) installed: ' + fvFn + ' @' + fvM.index);
      } else {
        logFn('[TRACE-TASK] FV probe NOT-FOUND');
      }
      // ★ BS 探针: dump _$bs (Feistel 解密) 输入 (base64解码后字节) + 密钥
      const bsSig = 'function _$bs(_$pR,_$kX){';
      let bsIdx = body.indexOf(bsSig);
      if (bsIdx >= 0) {
        const bsIn = 'try{typeof __oplog!=="undefined"?__oplog.push("BS_IN[L"+(typeof _$pR==="string"?_$pR.length:(_$pR&&_$pR.length))+"][K"+String(_$kX).slice(0,20)+"][D"+String(_$pR).slice(0,200)+"]"):0;}catch(__e){}';
        body = body.slice(0, bsIdx + bsSig.length) + bsIn + body.slice(bsIdx + bsSig.length);
        logFn('[TRACE-TASK] BS probe installed (idx=' + bsIdx + ')');
      }
      // ★ M6 探针: dump _$m6 (指纹生成器) 采样函数源码+值 (定位 [1]=213/182 来源)
      const m6Sig = 'function _$m6(){var _$pR,_$kX,_$k7;_$pR=[_$o5,_$dp,_$az,_$$j],_$kX=[_$iA(_$$r[33])];';
      let m6Idx = body.indexOf(m6Sig);
      if (m6Idx >= 0) {
        const m6In = 'try{typeof __oplog!=="undefined"?__oplog.push("M6D[F0="+String(_$pR[0]).slice(0,120)+"][F1="+String(_$pR[1]).slice(0,60)+"][F2="+String(_$pR[2]).slice(0,60)+"][F3="+String(_$pR[3]).slice(0,60)+"][I0="+_$kX[0]+"][V0="+_$pR[0]()+"][V1="+_$pR[1]()+"][V2="+_$pR[2]()+"][V3="+_$pR[3]()+"][TI="+typeof _$_I+"]"):0;}catch(__e){}';
        body = body.slice(0, m6Idx + m6Sig.length) + m6In + body.slice(m6Idx + m6Sig.length);
        logFn('[TRACE-TASK] M6 probe installed (idx=' + m6Idx + ')');
      }
      // ★ II 探针: dump 收集器 _$ii (编码器) 输入 JSON + 中间态 + 输出
      let iiIdx = body.indexOf('function _$ii(_$pR,_$kX){var _$k7;');
      if (iiIdx >= 0) {
        const iiIn = 'try{var __j=String(_$pD(_$pR));var __ks=[];for(var __k2 in _$pR)__ks.push(__k2);typeof __oplog!=="undefined"?__oplog.push("II_DUMP[L"+__j.length+"][K"+__ks.join(",")+"][J"+__j.slice(0,4000)+"]"):0;}catch(__e){}';
        body = body.slice(0, iiIdx + 'function _$ii(_$pR,_$kX){'.length) + iiIn + body.slice(iiIdx + 'function _$ii(_$pR,_$kX){'.length);
        // 编码输出点: _$ih(_$k7)) 前 dump 中间态 _$k7 (Feistel/压缩后) 和密钥 _$d2()
        const ihOut = '_$ih(_$k7)';
        const ihIdx = body.indexOf(ihOut, iiIdx);
        if (ihIdx >= 0) {
          const ihRep = '(function(){var __en=_$ih(_$k7);try{typeof __oplog!=="undefined"?__oplog.push("II_OUT[L"+__en.length+"][D2"+String(_$d2()).slice(0,16)+"][K7L"+_$k7.length+"][E"+__en.slice(0,240)+"]"):0;}catch(__e){}return __en;})()';
          body = body.slice(0, ihIdx) + ihRep + body.slice(ihIdx + ihOut.length);
        }
        logFn('[TRACE-TASK] II probe installed (idx=' + iiIdx + ')');
      }
    } else {
      logFn('[TRACE-TASK] oplog LOOP-NOT-FOUND (p2/p3/tv)');
    }
  } else {
    logFn('[TRACE-TASK] oplog DISABLED (NO_OPLOG)');
  }
  // ★ 退出点: 栈释放语句 X.Y(STK); 前注入返回状态 (ret4/ret5) 回填
  const stkEsc = stk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exitRe = new RegExp('([\\w$]+)\\.([\\w$]+)\\(' + stkEsc + '\\);');
  const em = exitRe.exec(body);
  if (em) {
    const exitLog =
      'try{if(typeof __taskLog!=="undefined"&&__taskLog.length<5000){' +
      '__taskLog.push({exit:1,start:' + p2 + ',end:' + p3 + ',ret4:' + p4 + '[4],ret5:__sh(' + p4 + '[5])});' +
      'for(var __k=__taskLog.length-2;__k>=0;__k--){var __e2=__taskLog[__k];' +
      'if(__e2.start===' + p2 + '&&__e2.end===' + p3 + '&&__e2.ret4===undefined){' +
      '__e2.ret4=' + p4 + '[4];__e2.ret5=__sh(' + p4 + '[5]);break;}}}}catch(e){}' +
      // ★ 退出时 dump 槽位区域 (与进入时 D530 对比, 定位写入者)
      'if(' + p2 + '===5&&' + p3 + '===530){try{var __e530=[];for(var __e530i=0;__e530i<100;__e530i++){var __e530v=' + p1 + '.' + tprop + '[__e530i];__e530.push(typeof __e530v==="string"?("s:"+__e530v):(typeof __e530v==="number"?("n:"+__e530v):(typeof __e530v==="function"?("f:"+String(__e530v).slice(0,15)):(typeof __e530v==="object"?((__e530v&&__e530v.slice)?("a"+__e530v.length):"[o]"):String(__e530v)))));}if(typeof __oplog!=="undefined")__oplog.push("===E530:"+__e530.join(","));}catch(__e530x){}}';
    body = body.replace(em[0], () => exitLog + em[0]);
    logFn('[TRACE-TASK] exit hook installed');
  }
  logFn('[TRACE-TASK] executor instrumented: fn=' + fn + ' taskprop=' + tprop);
  // ★ TEMP: 保存注入后 code, 供列号 97206 等精确定位
  // ★★★ 2026-08-19: 按长度区分保存 (executor ~357KB / 主 chunk ~530KB) — N/S 主 chunk 文本对比用
  try {
    require('fs').writeFileSync(body.length > 400000 ? 'chunk_injected.js' : 'exec_injected.js', body, 'utf-8');
  } catch (e) {}
  return body;
}


/**
 * instrumentMainChunk — 主 chunk (530KB eval) 特征向量函数插桩
 * 特征函数 (_$ox/_$_x/_$_3/_$k$/_$_s/_$aR 的 _$kL 变体) 入口 dump 特征向量
 * 对比 N/S 两侧特征向量演变 → 定位块类型选择分叉 (pfd0 vs pfc0)
 */
function instrumentMainChunk(code, logFn) {
  if (typeof code !== 'string' || code.length < 400000) return code;
  const dumpTpl = (tag) => 'try{if(typeof __oplog!=="undefined"&&__oplog.length<500000){' +
    '__oplog.push("FEAT:' + tag + '["+(typeof _$kL==="object"&&_$kL&&_$kL.slice?_$kL.slice(0,60).join(","):typeof _$kL)+"]");}}catch(__e){}';
  const fns = [['_$ox', 'ox'], ['_$_x', 'x'], ['_$_3', '3'], ['_$k$', 'k'], ['_$_s', 's'], ['_$aR', 'aR']];
  let out = code, n = 0;
  for (const [fn, tag] of fns) {
    const sig = 'function ' + fn + '(_$kL){';
    const idx = out.indexOf(sig);
    if (idx >= 0) {
      const ins = dumpTpl(tag);
      out = out.slice(0, idx + sig.length) + ins + out.slice(idx + sig.length);
      n++;
      if (logFn) logFn('[MAIN] feat fn ' + fn + ' instrumented @' + idx);
    } else if (logFn) logFn('[MAIN] feat fn ' + fn + ' NOT-FOUND');
  }
  if (logFn) logFn('[MAIN] instrumented ' + n + '/6 feat fns');
  return out;
}
/**
 * instrumentBoot — VM boot 字节码解释器插桩 (2026-08-31)
 * 锚定: while(1){VAR=BYTES[IDX++];if(VAR<436){...}
 * 输出 opcode 序列 :BT<n> → 对比 N/S 找第一个分叉 opcode
 * (cookie 0c 根因: opcode 102 才赋值 _$pZ=Array, N 侧未执行 → new 崩)
 */
function instrumentBoot(code, logFn) {
  if (typeof code !== 'string' || code.length < 400000) return code;
  const re = /while\(1\)\{([\w$]+)=([\w$]+)\[([\w$]+)\+\+\];if\(\1<436\)\{/;
  const m = re.exec(code);
  if (!m) { if (logFn) logFn('[BOOT] anchor NOT-FOUND'); return code; }
  const inj = 'try{typeof __oplog!=="undefined"&&__oplog.length<10000000?__oplog.push(":BT"+' + m[1] + '+"@"+' + m[3] + '):0;}catch(__e){}';
  const out = code.slice(0, m.index + m[0].length) + inj + code.slice(m.index + m[0].length);
  if (logFn) logFn('[BOOT] instrumented @' + m.index + ' var=' + m[1]);
  return out;
}

/**
 * instrumentKHCtor — 参数化构造器 _$kH 入口探针 (2026-08-31)
 * 锚定: function F(A,B){if(B.length===0)return new A();...}
 * 异常 'X is not a constructor' 的定位: dump 传入构造器类型/文本 (非函数时)
 */
function instrumentKHCtor(code, logFn) {
  if (typeof code !== 'string' || code.length < 400000) return code;
  const re = /function ([\w$]+)\(([\w$]+),([\w$]+)\)\{if\(\3\.length===0\)return new \2\(\)/;
  const m = re.exec(code);
  if (!m) { if (logFn) logFn('[KHC] anchor NOT-FOUND'); return code; }
  const inj = 'try{typeof __oplog!=="undefined"&&__oplog.length<10000000?(function(){var __c=' + m[2] +
    ';var __ok=typeof __c==="function";try{__ok=__ok&&!!__c.prototype;}catch(__e3){__ok=false;}if(!__ok&&typeof __oplog!=="undefined"&&__oplog.length<9999999){__oplog.push(":KHNONCTOR[t="+typeof __c+"|v="+String(__c).slice(0,70)+"]");}else if(typeof __oplog!=="undefined"&&__oplog.length<9999998){__oplog.push(":KHCALL[t="+typeof __c+"]");}})():0;}catch(__e){}';
  const headLen = ('function ' + m[1] + '(' + m[2] + ',' + m[3] + '){').length;
  const out = code.slice(0, m.index + headLen) + inj + code.slice(m.index + headLen);
  if (logFn) logFn('[KHC] instrumented @' + m.index);
  return out;
}

module.exports = { traceTaskExec, instrumentMainChunk, instrumentBoot, instrumentKHCtor };

