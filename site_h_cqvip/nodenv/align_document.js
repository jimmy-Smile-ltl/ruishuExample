// align_document.js — document 键集对齐 sdenv (jsdom 实测 doc_forin 217 键)
// ★ 根因: nodenv 的 document 仅 42 个可枚举键, sdenv/jsdom 217 个 →
//   VM 的 document 遍历 (15-44 段第 3-4 轮) 在 nodenv 收集到 0 个新属性 → 遍历轮缺失 → P 值不同 → 400
// 来源: sdenv/sdenv_props.json doc_forin (dump_props.js 实测)
'use strict';

const SDENV_DOC_KEYS = ["location","addEventListener","all","createExpression","getElementsByTagName","getElementsByTagNameNS","getElementsByClassName","createElement","createElementNS","createDocumentFragment","createTextNode","createCDATASection","createComment","createProcessingInstruction","importNode","adoptNode","createAttribute","createAttributeNS","createEvent","createRange","createNodeIterator","createTreeWalker","getElementsByName","open","close","write","writeln","hasFocus","clear","captureEvents","releaseEvents","getSelection","getElementById","prepend","append","replaceChildren","querySelector","querySelectorAll","implementation","URL","documentURI","compatMode","characterSet","charset","inputEncoding","contentType","doctype","documentElement","referrer","lastModified","readyState","title","dir","body","head","images","embeds","plugins","links","forms","scripts","currentScript","defaultView","onreadystatechange","anchors","applets","styleSheets","hidden","visibilityState","onvisibilitychange","onabort","onauxclick","onbeforeinput","onbeforematch","onbeforetoggle","onblur","oncancel","oncanplay","oncanplaythrough","onchange","onclick","onclose","oncontextlost","oncontextmenu","oncontextrestored","oncopy","oncuechange","oncut","ondblclick","ondrag","ondragend","ondragenter","ondragleave","ondragover","ondragstart","ondrop","ondurationchange","onemptied","onended","onerror","onfocus","onformdata","oninput","oninvalid","onkeydown","onkeypress","onkeyup","onload","onloadeddata","onloadedmetadata","onloadstart","onmousedown","onmouseenter","onmouseleave","onmousemove","onmouseout","onmouseover","onmouseup","onpaste","onpause","onplay","onplaying","onprogress","onratechange","onreset","onresize","onscroll","onscrollend","onsecuritypolicyviolation","onseeked","onseeking","onselect","onslotchange","onstalled","onsubmit","onsuspend","ontimeupdate","ontoggle","onvolumechange","onwaiting","onwebkitanimationend","onwebkitanimationiteration","onwebkitanimationstart","onwebkittransitionend","onwheel","ontouchstart","ontouchend","ontouchmove","ontouchcancel","onpointerover","onpointerenter","onpointerdown","onpointermove","onpointerrawupdate","onpointerup","onpointercancel","onpointerout","onpointerleave","ongotpointercapture","onlostpointercapture","activeElement","children","firstElementChild","lastElementChild","childElementCount","createNSResolver","evaluate","getRootNode","hasChildNodes","normalize","cloneNode","isEqualNode","isSameNode","compareDocumentPosition","contains","lookupPrefix","lookupNamespaceURI","isDefaultNamespace","insertBefore","appendChild","replaceChild","removeChild","nodeType","nodeName","baseURI","isConnected","ownerDocument","parentNode","parentElement","childNodes","firstChild","lastChild","previousSibling","nextSibling","nodeValue","textContent","ELEMENT_NODE","ATTRIBUTE_NODE","TEXT_NODE","CDATA_SECTION_NODE","ENTITY_REFERENCE_NODE","ENTITY_NODE","PROCESSING_INSTRUCTION_NODE","COMMENT_NODE","DOCUMENT_NODE","DOCUMENT_TYPE_NODE","DOCUMENT_FRAGMENT_NODE","NOTATION_NODE","DOCUMENT_POSITION_DISCONNECTED","DOCUMENT_POSITION_PRECEDING","DOCUMENT_POSITION_FOLLOWING","DOCUMENT_POSITION_CONTAINS","DOCUMENT_POSITION_CONTAINED_BY","DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC","removeEventListener","dispatchEvent"];

const DOC_CONSTANTS = {
  ELEMENT_NODE: 1, ATTRIBUTE_NODE: 2, TEXT_NODE: 3, CDATA_SECTION_NODE: 4,
  ENTITY_REFERENCE_NODE: 5, ENTITY_NODE: 6, PROCESSING_INSTRUCTION_NODE: 7,
  COMMENT_NODE: 8, DOCUMENT_NODE: 9, DOCUMENT_TYPE_NODE: 10,
  DOCUMENT_FRAGMENT_NODE: 11, NOTATION_NODE: 12,
  DOCUMENT_POSITION_DISCONNECTED: 1, DOCUMENT_POSITION_PRECEDING: 2,
  DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_CONTAINS: 8,
  DOCUMENT_POSITION_CONTAINED_BY: 16, DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC: 32,
};

// DOC_STRINGS 的 URL 值 (base64 存储, 运行时解码)。
// 实测检索站 9/9 不受该样本值影响 (VM 不校验 document.URL 与 location 的一致性)。
const _DOC_URL = Buffer.from('aHR0cHM6Ly9wc3Mtc3lzdGVtLmNwb25saW5lLmNuaXBhLmdvdi5jbi8=', 'base64').toString('utf8');
const DOC_STRINGS = {
  URL: _DOC_URL,
  documentURI: _DOC_URL,
  compatMode: 'CSS1Compat', characterSet: 'UTF-8', charset: 'UTF-8',
  inputEncoding: 'UTF-8', contentType: 'text/html', referrer: '',
  lastModified: '08/16/2026 08:00:00', readyState: 'complete', title: '', dir: '',
  nodeName: '#document', baseURI: _DOC_URL,
  visibilityState: 'visible',
};

function alignDocumentKeys(doc, win) {
  if (!doc || typeof doc !== 'object') return;
  try {
    // 1. 现有键的描述符 (含 getter 形态 — 保留!)
    const save = {};
    for (const k of Object.getOwnPropertyNames(doc)) {
      try { save[k] = Object.getOwnPropertyDescriptor(doc, k); } catch (e) {}
    }
    // 2. 补缺失键默认值 (类型与 jsdom 一致)
    const nativeFn = (name) => {
      const f = function () {};
      Object.defineProperty(f, 'name', { value: name, configurable: true });
      Object.defineProperty(f, 'toString', { value: () => `function ${name}() { [native code] }`, configurable: true });
      return f;
    };
    // ★ renderBodyFlag/cookie 缺失时补默认值 (jsdom 实测 for-in 可枚举 @5/@49);
    //   已存在则保留原描述符 — step 4 只改 enumerable (cookie 可能是 accessor, VM 写它进 cookie 存储!)
    for (const k of SDENV_DOC_KEYS) {
      if (k in save || Object.prototype.hasOwnProperty.call(doc, k)) continue;
      let v;
      if (DOC_CONSTANTS[k] !== undefined) v = DOC_CONSTANTS[k];
      else if (DOC_STRINGS[k] !== undefined) v = DOC_STRINGS[k];
      else if (k.startsWith('on')) v = null;             // jsdom 事件处理默认 null
      else if (k === 'location') v = win.location;
      else if (k === 'defaultView') v = win;
      else if (k === 'all') v = doc.all || (() => { try { return doc.all; } catch (e) { return null; } })();
      else if (k === 'doctype' || k === 'ownerDocument' || k === 'parentNode' ||
               k === 'parentElement' || k === 'firstChild' || k === 'lastChild' ||
               k === 'previousSibling' || k === 'nextSibling' || k === 'nodeValue' ||
               k === 'activeElement') v = null;
      else if (k === 'isConnected') v = true;
      else if (k === 'hidden') v = false;
      else if (k === 'renderBodyFlag') v = false;      // jsdom 实例标志位
      else if (k === 'cookie') v = '';                 // jsdom: 空字符串
      else if (k === 'textContent') v = '';
      else if (k === 'childElementCount') v = 0;
      else if (k === 'createExpression') {
        // ★ jsdom xpath 库行为: 解析表达式返回 XPathExpression (有 evaluate) —
        //   空 stub 返回 undefined → VM 任务 5 createExpression 分支分叉 (S=[o] N=undefined) → P 400
        v = function (expr, resolver) {
          const res = {
            evaluate: function (ctxNode, type, result) {
              // 最简求值: 匹配 //html //body //head 等简单路径
              const out = {
                numberValue: NaN, stringValue: '', booleanValue: false,
                singleNodeValue: null, invalidIteratorState: false,
                snapshotLength: 0, resultType: 0,
                iterateNext: function () { return null; },
                snapshotItem: function () { return null; },
              };
              try {
                const e = String(expr || '');
                const m = e.match(/\/([A-Za-z0-9_-]+)\s*$/);
                if (m) {
                  const tag = m[1].toLowerCase();
                  let node = null;
                  try {
                    if (tag === 'html') node = doc.documentElement;
                    else if (tag === 'body') node = doc.body;
                    else if (tag === 'head') node = doc.head;
                  } catch (e2) {}
                  if (node) { out.singleNodeValue = node; out.snapshotLength = 1; }
                }
                if (type === 1) out.numberValue = out.singleNodeValue ? 1 : 0;
              } catch (e3) {}
              return out;
            },
          };
          return res;
        };
        // ★★★ 2026-08-19 修复 (task 864): 匿名函数 name/toString 分叉 (源码形态 vs jsdom native 文本)
        //   __natName → fakePTS 查表 JS_TEXT['createExpression'] = 'function createExpression() { [native code] }'
        try { Object.defineProperty(v, 'name', { value: 'createExpression', configurable: true }); } catch (e3) {}
        try { Object.defineProperty(v, '__natName', { value: 'createExpression', configurable: true }); } catch (e3) {}
      }
      else v = nativeFn(k);
      save[k] = { value: v, writable: true, configurable: true, enumerable: true };
    }
    // 3. 删除全部可枚举键 (不可枚举保留原位)
    for (const k of Object.getOwnPropertyNames(doc)) {
      const d = save[k] || Object.getOwnPropertyDescriptor(doc, k);
      if (d && !d.enumerable) continue;
      try { delete doc[k]; } catch (e) {}
    }
    // 4. 按 jsdom 217 键顺序重建为可枚举
    // ★ 2026-08-31 重测 (jsdom 更新后): renderBodyFlag 已移除; cookie 访问器在原型 (实例无自有键);
    //   referrer = 实例自有 e:false 数据属性 (PROBE-AFTER: refDesc={e:false,w:false,g:false})
    const NON_ENUM = new Set(['referrer']);
    const extra = Object.keys(save).filter(k => !SDENV_DOC_KEYS.includes(k) && save[k] && save[k].enumerable);
    for (const k of SDENV_DOC_KEYS) {
      const d = save[k];
      if (!d) continue;
      try { Object.defineProperty(doc, k, { ...d, enumerable: !NON_ENUM.has(k) }); } catch (e) { try { doc[k] = d.value; } catch (e2) {} }
    }
    for (const k of extra) {
      const d = save[k];
      try { Object.defineProperty(doc, k, { ...d, enumerable: false }); } catch (e) {}
    }
    // ★★★ 2026-08-19 实验 (S 数组 document 子键区): VM 收集器对 window.document 做子键收集
    //   条件 = constructor.name === 'Document' (jsdom Document 对象特征) — N 的 document 是普通
    //   对象 (constructor=Object) → 收集器不收集 document 子键 → 15-44 数组缺 217 键 → 400
    try { Object.defineProperty(doc, 'constructor', { value: function Document() {}, writable: true, enumerable: false, configurable: true }); } catch (e2) {}
    try { Object.defineProperty(doc, Symbol.toStringTag, { value: 'Document', writable: false, enumerable: false, configurable: true }); } catch (e2) {}
    return true;
  } catch (e) {
    try { console.error('[ALIGN-DOC] err: ' + e.message); } catch (e2) {}
    return false;
  }
}

module.exports = { alignDocumentKeys, SDENV_DOC_KEYS };
