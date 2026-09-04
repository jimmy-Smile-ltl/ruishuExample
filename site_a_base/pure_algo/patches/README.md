# rs-reverse 必打补丁（2026 变体纯算法）

在 rs-reverse v1.16.3 上游 + pro36 定制的基础上，2026 变体纯算法需要以下补丁。
按文件列出，`src/` 路径相对于 rs-reverse 根目录。

## 1. `src/handler/globalVarible.js` — basestr 硬编码的坑（根源）

上游 `get basestr()` 硬编码了**一个站点**的字母表。2026 变体各校字母表不同
（在 `$_ts.cp[0]` 里，'.'→'-' 等变体）。**不要改这里的硬编码**——运行时从 cp0
动态提取（见 `rs_school_extract.js` 的结构 oracle 与 `rs_school_gen.js` 的
RS_ALPHA_IDX/自动匹配）。相关代码位置：`src/handler/parser/common/numarr2string.js`
与 `src/handler/parser/constData.js` 的 `makeDecryptKeys()` 都依赖它。

## 2. `src/handler/parser/tscd.js` — 两个补丁

### 2a. getTaskarr 递归守卫（脏 cd 死循环 → 崩溃）

脏 cd（用错字母表解密）会产生 NaN 索引 → `getTaskarr` 无限递归 → "Maximum call
stack size exceeded"。补丁（加 depth/NaN 守卫）：

```js
function getTaskarr(arr, idx, ans = {}, depth = 0) {
  if (idx >= arr.length || depth > 200 || !Number.isFinite(idx) || idx < 0) return ans;
  ...
  getTaskarr(arr, end + 2, ans, depth + 1);
  return ans;
}
```

### 2b. 偏移模板分支（RS_TEMPLATE 环境变量）

`exports.init()` 里 rawOff 的取值分支：

```js
let rawOff = process.env.RS_OFFSETS ? JSON.parse(process.env.RS_OFFSETS)
  : (process.env.RS_TEMPLATE ? (() => {
      // 偏移公式: offs[i] = cdTail[i] ^ TEMPLATE[i]（2026 变体破译）
      const T = [45, 2, 54, 52, 2, 54, 52, 48];
      return cdArr.slice(end, end + 8).map((x, i) => x ^ T[i]);
    })()
  : runTaskByUid('U14124020', [], ta));
```

模板 = `offsets[i] = cdArr[end+i] ^ [45,2,54,52,2,54,52,48]`（cd 尾 8 字节与固定
掩码 XOR）。约 70-80% 轮次有效；异常轮重试。

## 3. 运行时 decryptKeys 覆盖（cd 解密用真字母表）— 关键坑 #2

`cd` 本身也用站点真字母表编码。标准 init 链里 `constData.init()` 用硬编码字母表
生成 decryptKeys → `tscd.init()` 里 `decrypt(gv.ts.cd)` 解出 >255 脏字节 →
keys2/keys17 部分字节错 → 内层解密失败（keys16 恰好躲过，外层一直对——极具迷惑性）。

**修复：tscp 之后、tscd 之前，用 cp0 提取的真字母表重建 decryptKeys，且在
constData.init() 之后再覆盖一次**（constData 会重置）：

```js
require('./src/handler/parser/tscp').init(coder);
const alpha = parse(coder.$_ts.cp[0])[alphaIdx];  // 结构 oracle 检出
gv._setAttr('decryptKeys', makeDecryptKeys(alpha));
require('./src/handler/parser/constData').init();
gv._setAttr('decryptKeys', makeDecryptKeys(alpha));  // 再覆盖!
require('./src/handler/parser/tscd').init();
```

`makeDecryptKeys` = constData.js 里的同名函数（把 gv.basestr 换成 alpha）。

## 4. 字母表结构 oracle（提取脚本内置）

每个候选字母表（cp0/cp2 中 64~90 字符的串）：
设置 decryptKeys → 重推 keys → 解码真 P（4:3，strip 前缀）→ keys16 CBC 解密 →
判据 `na[4]===2 && na[5]===8 && |na[6..9]时间-now|<86400`。命中即真字母表。
每个候选的 init 都要 try/catch（脏 cd 会抛异常）。
