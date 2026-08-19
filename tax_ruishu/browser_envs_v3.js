var content = "arg1_content"


// ------------- 补环境开始  ------------
let is_logging = false
_log = console.log

function v_log() {
    if (is_logging) {
        _log(...arguments)
    }
}

// 定时器: 异步 + try/catch (关键! 同步 flush 会跳过 VM 的 timer 阶段,
// 导致 basearr 少 30 字节被服务端拒收; try/catch 让缺 API 不崩)
!(function () {
    setInterval_ = setInterval;
    setInterval = function (v1, v2) {
        return setInterval_(function () {
            try { v1(); } catch (e) {}
        }, v2)
    }
    setInterval.toString = function () {
        return setInterval_.toString();
    };
})();
!(function () {
    setTimeout_ = setTimeout;
    setTimeout = function (v1, v2) {
        return setTimeout_(function () {
            try { v1(); } catch (e) {}
        }, v2)
    }
    setTimeout.toString = function () {
        return setTimeout_.toString();
    };
})();
// 过掉toString检测
!(function () {
    "use strict";
    const $toString = Function.toString;
    const myFunction_toString_symbol = Symbol('('.concat('', ')_', (Math.random() + '').toString(36)));
    const mytoString = function () {
        return typeof this == 'function' && this[myFunction_toString_symbol] || $toString.call(this);
    };

    function set_native(func, key, value) {
        Object.defineProperty(func, key, {
            "enumerable": false,
            "configurable": true,
            "writable": true,
            "value": value
        })
    };
    delete Function.prototype['toString'];
    set_native(Function.prototype, "toString", mytoString);
    set_native(Function.prototype.toString, myFunction_toString_symbol, "function toString() { [native code] }");
    this.func_set_native = function (func) {
        set_native(func, myFunction_toString_symbol, `function ${myFunction_toString_symbol, func.name || ''}() { [native code] }`)
    }
}).call(this);

// Window = function Window(){};
// window = new Window();
// for(let name in global){
//     switch(name){
//         case "window":
//             continue;
//         case "global":
//             continue;
//     }
//     window[name] = global[name];
//     delete global[name];
// }
// Object.setPrototypeOf(global,window); // 设置原型链给global 设置window

function updateFunToString(callback, extName) {
    if (callback.name === 'webdriver') {
        Object.defineProperty(callback, 'name', {
            value: `get ${callback.name}`,
            configurable: true,
            writable: false,
            enumerable: false
        });
    }
    let toStr = `function ${callback.name}() { [native code] }`;
    if (callback.name && extName) {
        toStr = `function ${extName} ${callback.name}() { [native code] }`;
    } else if (extName) {
        toStr = `function ${extName}() { [native code] }`;
    }
    Object.defineProperty(callback, 'toStr', {
        enumerable: false,
        configurable: true,
        writable: true,
        value: toStr
    });
    return callback;
}

const originToString = Function.prototype.toString;
Object.defineProperty(Function.prototype, 'toString', {
    enumerable: false,
    configurable: true,
    writable: true,
    value: updateFunToString(function toString() {
        let toStr = this.toStr;
        console.log(toStr, 'toString_toStr', this.name)
        return toStr || Reflect.apply(originToString, this, arguments)
    })
});

Window = function () {
}
window = self = parent = top = global;
window.__proto__ = Window.prototype // "try{return (window instanceof Window);}catch(e){}"
// delete global;
delete GLOBAL;
delete root;
delete __filename;
delete __dirname;

window.top = window;

// ===== v3: setFuncNative 原生伪装层 (pro11 方案 B v3 移植, 2026-08-15) =====
// 原模板的 func_set_native 定义后从未调用 (死代码), VM 逐个函数 toString 检测裸奔
// 原理: 白名单函数名 + 每函数自定义 toString 返回 function <本名>() { [native code] }
!(function () {
    var canToStrigArr = [];
    var originToString = Function.prototype.toString;
    var nativeToString = function () {
        if (canToStrigArr.indexOf(this.name) > -1) {
            return 'function ' + (this.name || '') + '() { [native code] }';
        }
        return originToString.call(this);
    };
    var setFuncNative = function (func, name, len) {
        if (!func) return undefined;
        if (typeof name === 'string') Object.defineProperty(func, 'name', { value: name });
        else if (typeof name === 'number') len = name;
        if (typeof len === 'number') Object.defineProperty(func, 'length', { value: len });
        canToStrigArr.push(func.name);
        Object.defineProperty(func, 'toString', {
            enumerable: false, configurable: true, writable: true, value: nativeToString,
        });
        return func;
    };
    setFuncNative(nativeToString, 'toString');
    try { Function.prototype.toString = nativeToString; } catch (e) { }
    var list = [
        // timer / 基础
        ['setTimeout', 1], ['setInterval', 1], ['clearTimeout', 0], ['clearInterval', 0],
        ['requestAnimationFrame', 1], ['cancelAnimationFrame', 1],
        ['webkitRequestAnimationFrame', 1], ['webkitCancelAnimationFrame', 1],
        ['queueMicrotask', 1], ['atob', 1], ['btoa', 1],
        // 弹窗/窗口
        ['alert', 0], ['confirm', 0], ['prompt', 0], ['print', 0], ['open', 0],
        ['close', 0], ['focus', 0], ['blur', 0], ['stop', 0],
        ['moveTo', 2], ['moveBy', 2], ['resizeTo', 2], ['resizeBy', 2],
        ['captureEvents', 0], ['releaseEvents', 0],
        ['scroll', 0], ['scrollTo', 0], ['scrollBy', 0],
        // DOM / 查询
        ['getComputedStyle', 1], ['getSelection', 0], ['postMessage', 1], ['find', 0],
        ['fetch', 1], ['createImageBitmap', 1], ['reportError', 1],
        ['structuredClone', 1], ['requestIdleCallback', 1], ['cancelIdleCallback', 1],
        // 事件 / 网络
        ['Event', 1], ['CustomEvent', 1], ['Request', 1], ['Worker', 1],
        ['matchMedia', 1], ['MediaQueryList', 1],
        // 原型 / 其他
        ['Date.prototype.getTime', 0],
        ['HTMLCanvasElement.prototype.toDataURL', 0],
        ['HTMLCanvasElement.prototype.toBlob', 1],
    ];
    for (var i = 0; i < list.length; i++) {
        try {
            var parts = list[i][0].split('.');
            var obj = global;
            for (var j = 0; j < parts.length - 1; j++) {
                if (obj[parts[j]] === undefined) { obj = null; break; }
                obj = obj[parts[j]];
            }
            var fn = obj && obj[parts[parts.length - 1]];
            if (fn) setFuncNative(fn, parts[parts.length - 1], list[i][1]);
        } catch (e) { }
    }
    try { setFuncNative(location.replace, 'replace', 1); } catch (e) { }
    try { setFuncNative(location.assign, 'assign', 1); } catch (e) { }
    // eval 伪装 native (33 chars, 瑞数 runtimeConfig 实测值)
    try {
        var origEval = eval;
        var fakeEval = function (code) { return origEval(code); };
        fakeEval.toString = function () { return 'function eval() { [native code] }'; };
        global.eval = fakeEval;
    } catch (e) { }
})();
// ===== v3 伪装层 END =====


var _null = function () {
    v_log("--arguments--", ...arguments)
};

window.outerHeight = 1080
window.outerWidth = 1920
window.Math = Math;
window.Date = Date;
window.parseInt = parseInt;
window.addEventListener = _null
window.attachEvent = undefined
HTMLFormElement = function () {
    this.init();
    return this.json;
}
window.HTMLFormElement = HTMLFormElement
window.openDatabase = function openDatabase(dbname, version, description, dbsize, dbcallback) {
    debugger;
    return {
        version: version
    }
};
window.chrome = {
    "app": {
        "isInstalled": false,
        "InstallState": {
            "DISABLED": "disabled",
            "INSTALLED": "installed",
            "NOT_INSTALLED": "not_installed"
        },
        "RunningState": {
            "CANNOT_RUN": "cannot_run",
            "READY_TO_RUN": "ready_to_run",
            "RUNNING": "running"
        }
    }
}
window.onbeforeunload = function _$8a(_$hM) {
    if (_$Sq) {
        _$IY(new _$Bd(_$BJ, {}, _$BS(_$hM[_$Mi(_$zu[41])])));
        _$CQ();
    }
}

window.ActiveXObject = undefined


div = {
    getElementsByTagName: function (arg) {
        _log(...arguments)
        if (arg === "i") {
            return {length: 0}
        }
    }
}
meta = {
    getAttribute: function (arg) {
        if (arg === "r") {
            return "m"
        }
    },
    parentNode: {
        removeChild: function () {
            _log("removeChild", ...arguments)
        }
    },
    content: content
}
getAttribute = function () {
    if (arguments[0] == 'r') {
        return 'm'
    }
}
script1 = {
    getAttribute: getAttribute,
    parentElement: {
        removeChild: function () {
            console.log('script1.parentElement.removeChild', arguments)
        }
    }
}
script2 = {
    getAttribute: getAttribute,
    parentElement: {
        removeChild: function () {
            console.log('script2.parentElement.removeChild', arguments)
        }
    }
}
script = [
    script1,
    script2,
]

// 后缀的位置
var elemA = {
    _href: '',
    set href(x) {
        console.log('set a href: ', x)
        if (!x.startsWith('http')) {
            if (x.startsWith('./')) {
                this._href = this.origin + '/' + x.replace('./', '')
            } else {
                this._href = this.origin + x
            }

        } else {
            this._href = x.replace(':443', '').replace(':80', '')
        }
    },
    get href() {
        console.log('get a href: ', this._href)
        return this._href
    },
    hostname: '', // webURL.split('://')[1]
    hash: '',
    origin: '', // webURL
    protocol: '', // webURL.split('//')[0]  http:
    pathname: "", // "/mall/service/query/QueryNavigations"
    port: '', // 80
    search: '', // ?mode=10
}

function getImageDate() {
    return 'function getImageData() { [native code] }'
}

CanvasRenderingContext2D = {
    canvas: {},
    direction: "ltr",
    fillStyle: "#000000",
    filter: "none",
    font: "10px sans-serif",
    fontKerning: "auto",
    fontStretch: "normal",
    fontVariantCaps: "normal",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "low",
    letterSpacing: "0px",
    lineCap: "butt",
    lineDashOffset: 0,
    lineJoin: "miter",
    lineWidth: 1,
    miterLimit: 10,
    shadowBlur: 0,
    shadowColor: "rgba(0, 0, 0, 0)",
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    strokeStyle: "#000000",
    textAlign: "start",
    textBaseline: "alphabetic",
    textRendering: "auto",
    wordSpacing: "0px",
    getImageDate: getImageDate
}

_ddd = {
    get: function () {
    }
}

_canvas = {
    getContext: function (arg) {
        if (arg === "2d") {
            return CanvasRenderingContext2D
        }

    },
    toDataURL: function () {
        return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASwAAACWCAYAAABkW7XSAAAAAXNSR0IArs4c6QAABGJJREFUeF7t1AEJAAAMAsHZv/RyPNwSyDncOQIECEQEFskpJgECBM5geQICBDICBitTlaAECBgsP0CAQEbAYGWqEpQAAYPlBwgQyAgYrExVghIgYLD8AAECGQGDlalKUAIEDJYfIEAgI2CwMlUJSoCAwfIDBAhkBAxWpipBCRAwWH6AAIGMgMHKVCUoAQIGyw8QIJARMFiZqgQlQMBg+QECBDICBitTlaAECBgsP0CAQEbAYGWqEpQAAYPlBwgQyAgYrExVghIgYLD8AAECGQGDlalKUAIEDJYfIEAgI2CwMlUJSoCAwfIDBAhkBAxWpipBCRAwWH6AAIGMgMHKVCUoAQIGyw8QIJARMFiZqgQlQMBg+QECBDICBitTlaAECBgsP0CAQEbAYGWqEpQAAYPlBwgQyAgYrExVghIgYLD8AAECGQGDlalKUAIEDJYfIEAgI2CwMlUJSoCAwfIDBAhkBAxWpipBCRAwWH6AAIGMgMHKVCUoAQIGyw8QIJARMFiZqgQlQMBg+QECBDICBitTlaAECBgsP0CAQEbAYGWqEpQAAYPlBwgQyAgYrExVghIgYLD8AAECGQGDlalKUAIEDJYfIEAgI2CwMlUJSoCAwfIDBAhkBAxWpipBCRAwWH6AAIGMgMHKVCUoAQIGyw8QIJARMFiZqgQlQMBg+QECBDICBitTlaAECBgsP0CAQEbAYGWqEpQAAYPlBwgQyAgYrExVghIgYLD8AAECGQGDlalKUAIEDJYfIEAgI2CwMlUJSoCAwfIDBAhkBAxWpipBCRAwWH6AAIGMgMHKVCUoAQIGyw8QIJARMFiZqgQlQMBg+QECBDICBitTlaAECBgsP0CAQEbAYGWqEpQAAYPlBwgQyAgYrExVghIgYLD8AAECGQGDlalKUAIEDJYfIEAgI2CwMlUJSoCAwfIDBAhkBAxWpipBCRAwWH6AAIGMgMHKVCUoAQIGyw8QIJARMFiZqgQlQMBg+QECBDICBitTlaAECBgsP0CAQEbAYGWqEpQAAYPlBwgQyAgYrExVghIgYLD8AAECGQGDlalKUAIEDJYfIEAgI2CwMlUJSoCAwfIDBAhkBAxWpipBCRAwWH6AAIGMgMHKVCUoAQIGyw8QIJARMFiZqgQlQMBg+QECBDICBitTlaAECBgsP0CAQEbAYGWqEpQAAYPlBwgQyAgYrExVghIgYLD8AAECGQGDlalKUAIEDJYfIEAgI2CwMlUJSoCAwfIDBAhkBAxWpipBCRAwWH6AAIGMgMHKVCUoAQIGyw8QIJARMFiZqgQlQMBg+QECBDICBitTlaAECBgsP0CAQEbAYGWqEpQAAYPlBwgQyAgYrExVghIgYLD8AAECGQGDlalKUAIEDJYfIEAgI2CwMlUJSoCAwfIDBAhkBAxWpipBCRAwWH6AAIGMgMHKVCUoAQIGyw8QIJARMFiZqgQlQMBg+QECBDICBitTlaAECBgsP0CAQEbAYGWqEpQAgQdWMQCX4yW9owAAAABJRU5ErkJggg=='
    },
}
window.canvas = _canvas

Navigator = function Navigator() {
}
Navigator.prototype = {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    webdriver: false,
    languages: ['en-GB', 'zh-CN', 'zh'],
    platform: "Win32",
    webkitPersistentStorage: {},

}
window.navigator = {};
window.navigator.__proto__ = Navigator.prototype

// 目标 URL (base64, 运行时解码) — location 参与环境指纹, 与请求保持一致
var TARGET_URL = Buffer.from('aHR0cHM6Ly9ldGF4LnRpYW5qaW4uY2hpbmF0YXguZ292LmNuOjg0NDMv', 'base64').toString('utf8');
var _m = /^(\w+):\/\/([^\/]+?)(:\d+)?(\/.*)?$/.exec(TARGET_URL);
Location = function () {
}
Location.prototype = {
    "ancestorOrigins": {},
    "href": TARGET_URL,
    "origin": _m[1] + '://' + _m[2] + (_m[3] || ''),
    "protocol": _m[1] + ':',
    "host": _m[2] + (_m[3] || ''),
    "hostname": _m[2],
    "port": (_m[3] || '').replace(':', ''),
    "pathname": _m[4] || '/',
    "search": "",
    "hash": ""
}

window.location = new Location;


History = function History() {
}
History.prototype.back = function back() {
}
History.prototype.replaceState = function replaceState() {
}
History.prototype.pushState = function pushState() {
}
window.history = new History

Screen = function () {
}
Screen.prototype = {
    availWidth: 1920,
    availHeight: 1080,
    availLeft: 0,
    availTop: 0,
    height: 960,
    width: 1707
}
window.screen = new Screen

FengNewAll = function FengNewAll() {
}
const HTMLAllCollection = function HTMLAllCollection() {
};
HTMLAllCollection.name = "HTMLAllCollection";
HTMLAllCollection.length = 0;
HTMLAllCollection.prototype = Array.prototype;
HTMLAllCollection.prototype.constructor = HTMLAllCollection;
const myObject = {};
myObject.all = new FengNewAll();
Object.setPrototypeOf(myObject.all, HTMLAllCollection.prototype);
// 内容对齐真实 412 页: 3 个元素 (meta + 2 script)
myObject.all.push(meta, script1, script2);
myObject.all.toString = function () { return "[object HTMLAllCollection]"; };
Object.defineProperty(myObject.all, Symbol.toStringTag, { value: "HTMLAllCollection" });


Document = function Document() {
}
Document.prototype = {
    getElementById: function getElementById() {
        _log(arguments)
        // 返回通用元素 (timer 阶段会对其设 .id)
        return {
            set id(x) { this._id = x; },
            get id() { return this._id; },
            setAttribute: function () {},
            getAttribute: getAttribute,
            removeAttribute: function () {},
            removeChild: function (c) { return c; },
            appendChild: function (c) { if (c && typeof c === 'object') c.parentNode = this; return c; },
            insertBefore: function (c) { if (c && typeof c === 'object') c.parentNode = this; return c; },
            style: {},
            children: [],
            parentNode: { removeChild: function () {}, appendChild: function () {} },
        }
    },
    createElement: function (a) {
        _log(arguments)
        if (a === "div") {
            return div
        }
        if (a === "a") {
            // a 元素命中时返回通用对象即可 (无特定结构要求)
        }
        if (a === "form") {
            return {}
        }
        if (a === "canvas") {
            return _canvas
        }
        if (a === "script") {
            return "<scripts></scripts>";
        }
    },
    getElementsByTagName: function (arg) {
        console.log("getElementsByTagName-->", arguments)
        if (arg === "script") {
            return script
        }
        if (arg === "meta") {
            return [meta, meta]
        }
        if (arg === "base") {
            return {}
        }

    },
    addEventListener: _null,
    appendChild: _null,
    removeChild: _null,
    documentElement: {},
    body: {},
    visibilityState: 'visible',
    characterSet: 'UTF-8',
    charset: 'UTF-8'
}

Object.defineProperty(Document.prototype, "all", {
    get: function () {
        return myObject.all;
    },
    configurable: true,
    enumerable: true
})

window.document = new Document;
Object.setPrototypeOf(document, Document.prototype);
console.log("typeof document.all: ", typeof document.all);

window.localStorage = function () {
};
Storage = function () {
};
Storage.prototype.getItem = function getItem(key) {
};
Storage.prototype.setItem = function setItem(key, value) {
};


var XMLHttpRequest = function () {
    console.log("--XMLHttpRequest--", ...arguments)
}
window.open = function () {
    console.log("--window.open--", ...arguments)
}
let xhr_proto = {
    open: function (v1, v2, v3) {
        // req_param = v2.split("?")[1]
        // return void 0
        return arguments
    },
    send: function () {
        return void 0
    }
}
Object.setPrototypeOf(XMLHttpRequest, xhr_proto)
XMLHttpRequest.prototype = xhr_proto
window.XMLHttpRequest = XMLHttpRequest

/*// 定义 XMLHttpRequest
var XMLHttpRequest = function () {
    this.readyState = 0;
    this.status = 0;
};
set_native(XMLHttpRequest);

XMLHttpRequest.prototype.open = function (method, url, async) {
    // console.log("-- 基础 open 被调用 --", method, url);
    return url;
};
set_native(XMLHttpRequest.prototype.open);
XMLHttpRequest.prototype.send = function () {
};
set_native(XMLHttpRequest.prototype.send);
window.XMLHttpRequest = XMLHttpRequest;*/

/*function get_rs_suffix_url(method, targetUrl) {
    const urlParts = targetUrl.split('?');
    // 动态同步，骗过瑞数的签名计算
    window.location.pathname = urlParts[0];
    window.location.search = urlParts[1] ? '?' + urlParts[1] : '';
    window.location.href = window.location.origin + window.location.pathname + window.location.search;

    var xhr = new window.XMLHttpRequest();
    // 如果瑞数加载成功，这里的 .open 应该返回带后缀的字符串
    return xhr.open(method, targetUrl);
}*/


// 删除 Node 全局泄漏 (保守版: 保留 process/Buffer 供 undici, 删 require/module)
try { delete global.require; } catch (e) {}
try { delete global.module; } catch (e) {}
try { delete global.global; } catch (e) {}
try { delete global.exports; } catch (e) {}
try { delete global.queueMicrotask; } catch (e) {}

"arg2_js";
// v3: VM 执行期间隐藏 node 全局 (jsdom 沙箱没有 process/global)
!(function () {
    var _p = process, _g = globalThis;
    try {
        process = undefined;
        globalThis.process = undefined;
        "ts_code"; // placeholder: spider 替换带引号的占位符
    } finally {
        process = _p;
        globalThis.process = _p;
    }
})();

/*
console.log("检测open是否被重写：", window.XMLHttpRequest.prototype.open.toString());
// 获取后缀
setTimeout(() => {
    var apiUrl = "/auth/jwt/token-aes";
    var resultUrl = get_rs_suffix_url('POST', apiUrl);
    console.log("生成的带后缀URL: ", resultUrl);
}, 500);
*/

function get_cookie() {
    return document.cookie;
}