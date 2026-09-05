// 剥离 http 页面上 cookie 的 Secure 属性（对齐真 Chrome 语义：RFC 6265bis 在非安全源忽略 Secure）
(function () {
    var __d = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    Object.defineProperty(Document.prototype, 'cookie', {
        get: __d.get,
        set: function (v) {
            return __d.set.call(this, String(v).replace(/;\s*secure/ig, ''));
        }
    });
})();
