function skipStringLiteral(code, i, quote) {
  // i 指向开引号, 返回引号结束后位置
  let k = i + 1;
  const n = code.length;
  while (k < n) {
    const ch = code[k];
    if (ch === '\\') { k += 2; continue; }
    if (ch === quote) return k + 1;
    if (quote === '`' && ch === '$' && code[k + 1] === '{') {
      // 模板插值: 跳过 ${...} 表达式
      let d = 1;
      k += 2;
      while (k < n && d > 0) {
        const c2 = code[k];
        if (c2 === '"' || c2 === "'" || c2 === '`') { k = skipStringLiteral(code, k, c2); continue; }
        if (c2 === '/' && code[k + 1] === '/') { k = code.indexOf('\n', k); if (k < 0) return n; continue; }
        if (c2 === '/' && code[k + 1] === '*') { const e = code.indexOf('*/', k + 2); k = e < 0 ? n : e + 2; continue; }
        if (c2 === '{') d++;
        else if (c2 === '}') d--;
        k++;
      }
      continue;
    }
    k++;
  }
  return n;
}

function skipRegexLiteral(code, i) {
  // i 指向 '/', 返回正则结束后位置 (支持字符类 [..])
  let k = i + 1;
  const n = code.length;
  let inClass = false;
  while (k < n) {
    const ch = code[k];
    if (ch === '\\') { k += 2; continue; }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      // 跳过 flags
      k++;
      while (k < n && /[A-Za-z]/.test(code[k])) k++;
      return k;
    }
    k++;
  }
  return n;
}

function isRegexStart(code, i) {
  // 启发式: '/' 前一个有效字符是运算符/分隔符/起始
  let j = i - 1;
  while (j >= 0 && /\s/.test(code[j])) j--;
  if (j < 0) return true;
  const prev = code[j];
  return /[=(,\[!&|?{};:+\-*%^~<>]/.test(prev) || code.startsWith('return', Math.max(0, j - 5));
}

function getHoistedFunctions() {
  if (gv._hoistedFns !== undefined) return gv._hoistedFns;
  const code = gv.config.code || '';
  const decls = [];
  const n = code.length;
  let i = 0;
  while (i < n) {
    const ch = code[i];
    // 注释
    if (ch === '/' && code[i + 1] === '/') {
      i = code.indexOf('\n', i);
      if (i < 0) break;
      i++;
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      const e = code.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    // 字符串 / 模板串
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipStringLiteral(code, i, ch);
      continue;
    }
    // 正则字面量
    if (ch === '/' && isRegexStart(code, i)) {
      i = skipRegexLiteral(code, i);
      continue;
    }
    // function 声明
    if (code.startsWith('function', i) && (i === 0 || !/[A-Za-z0-9_$]/.test(code[i - 1]))) {
      const rest = code.slice(i + 8);
      const nameM = rest.match(/^([A-Za-z_$][\w$]*)\s*\(/);
      if (nameM) {
        // 参数列表括号匹配 (词法感知)
        let k = i + 8 + nameM[0].length - 1; // '('
        let depth = 0;
        for (; k < n; k++) {
          const c = code[k];
          if (c === '"' || c === "'" || c === '`') { k = skipStringLiteral(code, k, c) - 1; continue; }
          if (c === '/' && isRegexStart(code, k)) { k = skipRegexLiteral(code, k) - 1; continue; }
          if (c === '(') depth++;
          else if (c === ')') { depth--; if (depth === 0) break; }
        }
        // 跳过空白到 '{'
        let j = k + 1;
        while (j < n && /\s/.test(code[j])) j++;
        if (code[j] === '{') {
          let depth2 = 0;
          for (; j < n; j++) {
            const c = code[j];
            if (c === '"' || c === "'" || c === '`') { j = skipStringLiteral(code, j, c) - 1; continue; }
            if (c === '/' && isRegexStart(code, j)) { j = skipRegexLiteral(code, j) - 1; continue; }
            if (c === '{') depth2++;
            else if (c === '}') { depth2--; if (depth2 === 0) { decls.push(code.slice(i, j + 1)); break; } }
          }
          i = j + 1;
          continue;
        }
      }
    }
    i++;
  }
  gv._hoistedFns = decls.join('\n');
  logger.debug(`[HOIST] 预提升 ${decls.length} 个函数声明`);
  return gv._hoistedFns;
}

/**
 * 提取 IIFE 顶层的 var 数据声明 (v7)
 *
 * 剩余崩溃类: 片段直接引用顶层数据资源名 (如 _$fq[_$eM]) — 数据数组
 * 声明未被提升 → ReferenceError。真实 VM 整程序 eval 时这些绑定天然存在。
 *
 * 策略: 找 IIFE 体深度, 该层的 var 声明逐条 try/catch 求值
 * (函数已整体提升, 计算型初始化大概率可执行; 失败保持 undefined)。
 */
function getHoistedVars() {
  if (gv._hoistedVars !== undefined) return gv._hoistedVars;
  const code = gv.config.code || '';
  const decls = [];
  const n = code.length;
  // 1. IIFE 体深度 = 第一个 (function 后的 '{' 所在层
  let iifeDepth = 0;
  {
    let depth = 0;
    let seenFn = false;
    for (let i = 0; i < n; i++) {
      const ch = code[i];
      if (ch === '"' || ch === "'" || ch === '`') { i = skipStringLiteral(code, i, ch) - 1; continue; }
      if (ch === '/' && code[i + 1] === '/') { i = code.indexOf('\n', i); if (i < 0) break; continue; }
      if (ch === '/' && code[i + 1] === '*') { const e = code.indexOf('*/', i + 2); i = e < 0 ? n : e + 1; continue; }
      if (ch === '/' && isRegexStart(code, i)) { i = skipRegexLiteral(code, i) - 1; continue; }
      if (code.startsWith('function', i) && (i === 0 || !/[A-Za-z0-9_$]/.test(code[i - 1]))) seenFn = true;
      if (ch === '{') {
        depth++;
        if (seenFn && iifeDepth === 0) { iifeDepth = depth; break; }
      } else if (ch === '}') depth--;
    }
  }
  // 2. 扫描 iifeDepth 层的 var 声明
  let depth = 0;
  let i = 0;
  while (i < n) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = skipStringLiteral(code, i, ch); continue; }
    if (ch === '/' && code[i + 1] === '/') { i = code.indexOf('\n', i); if (i < 0) break; i++; continue; }
    if (ch === '/' && code[i + 1] === '*') { const e = code.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (ch === '/' && isRegexStart(code, i)) { i = skipRegexLiteral(code, i); continue; }
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') { depth--; i++; continue; }
    if (depth === iifeDepth && code.startsWith('var ', i)
        && (i === 0 || !/[A-Za-z0-9_$]/.test(code[i - 1]))) {
      let j = i;
      let d2 = 0;
      while (j < n) {
        const c = code[j];
        if (c === '"' || c === "'" || c === '`') { j = skipStringLiteral(code, j, c); continue; }
        if (c === '/' && isRegexStart(code, j)) { j = skipRegexLiteral(code, j); continue; }
        if (c === '[' || c === '(' || c === '{') d2++;
        else if (c === ']' || c === ')' || c === '}') d2--;
        else if (c === ';' && d2 === 0) break;
        j++;
      }
      const seg = code.slice(i, j);
      // 拆分多声明 (逗号在括号/方括号内不拆)
      const parts = [];
      let s = 4, d3 = 0;
      for (let k = 4; k < seg.length; k++) {
        const c = seg[k];
        if (c === '"' || c === "'" || c === '`') { k = skipStringLiteral(seg, k, c) - 1; continue; }
        if (c === '[' || c === '(' || c === '{') d3++;
        else if (c === ']' || c === ')' || c === '}') d3--;
        else if (c === ',' && d3 === 0) { parts.push(seg.slice(s, k).trim()); s = k + 1; }
      }
      parts.push(seg.slice(s).trim());
      for (const p of parts) {
        if (!p) continue;
        const eq = p.indexOf('=');
        const name = (eq > 0 ? p.slice(0, eq) : p).trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
        if (eq < 0) {
          decls.push(`var ${name};`);
          continue;
        }
        const init = p.slice(eq + 1).trim();
        // 逐条 try/catch: 函数已整体提升, 计算型初始化大多可执行
        decls.push(`var ${name};\ntry { ${name} = ${init}; } catch(e) {}`);
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  gv._hoistedVars = decls.join('\n');
  logger.debug(`[HOIST] 预提升 ${decls.length} 个 var 声明`);
  return gv._hoistedVars;
}
