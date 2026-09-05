// 剥离 http 页面上 cookie 的 Secure 属性（对齐真 Chrome 语义：RFC 6265bis 在非安全源忽略 Secure）
// 用于 iv8 0.1.4 在 http:// 站点执行瑞数 VM 的场景（站点I 海关第一层根因的修复）
(function () {
    var __d = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    Object.defineProperty(Document.prototype, 'cookie', {
        get: __d.get,
        set: function (v) {
            return __d.set.call(this, String(v).replace(/;\s*secure/ig, ''));
        }
    });
})();
