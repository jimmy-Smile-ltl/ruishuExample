# 站点F：税务局（TLS 指纹双变体版）

> 瑞数6代 + **按 HTTP 层指纹（TLS/JA3）分发两套挑战 JS 的"双变体"机制**——本仓库此前未收录的新版本特征。
> 目标 URL 已 base64 编码（运行时自动解码），实名映射见仓库根 `sites_mapping.local.md`。

## 一、版本特征（双变体机制）

首次访问 412 挑战页后，服务端按客户端 **TLS 指纹**（非 UA！）分发不同的挑战 JS 文件：

| 客户端 | 分发的 JS | 生成的解混淆器 | 行为 |
|--------|----------|---------------|------|
| 真实浏览器（Chrome TLS） | `gXWcRZZbhy0V.43ade2a.js`（174KB） | 191KB 友好版 | 1s 通关 |
| Node/curl（OpenSSL TLS） | `jj8pkMDMKUcA.43ade2a.js`（234KB） | 294KB 反机器版 | `window['escape']` 门控死循环 |

- 反机器版的门控：`_$hu = _$gp || window['escape'] || !Math['floor']` 恒真 → 7-opcode 周期无限循环
- **浏览器配 Firefox UA 仍拿友好版**——变体由 TLS 层指纹决定，与 UA 无关
- 反机器版（294KB）还有两层 toString 自检：插桩即触发 `Invalid array length`（Node 侧）/服务端空白页惩罚（浏览器侧）
- **2026-08-19 起服务器统一分发友好版**（jj8pkMDMKUcA.43ade2a.js，204688 字符 / 234513 字节），curl_cffi 抓 412 直接拿友好版，不再需要 TLS 冒充；友好版无 escape 门控、无 toString 自检，插桩安全

## 二、技术路线与实测（2026-08）

| 路线 | 关键文件 | 实测 |
|------|---------|------|
| **rs-reverse 纯算法**（主推） | `spider_rs_pure.py` + `patch_rs_reverse_tj.py` + `lenTj.js` | ✅ **7/7 轮 200，~1s/次** |
| 手写补环境（备用） | `spider_manual_env.py` + `browser_envs_v3.js` | ✅ 5/5 轮 200，2.2-3.0s/次 |
| **sdenv 补环境**（2026-08-19 新通） | `spider_sdenv_tj.py` + `generate_cookie_tj.js` | ✅ 2/2 轮 200，~17s/次 |

```bash
# 纯算法（无浏览器，最快）
pip install curl_cffi && npm install rs-reverse
python patch_rs_reverse_tj.py && python spider_rs_pure.py

# 手写补环境（零 npm 依赖，备用）
pip install curl_cffi && python spider_manual_env.py

# sdenv 补环境（jsdom，需 npm sdenv）
python spider_sdenv_tj.py
```

## 三、纯算法路线分析过程（完整链路）

### 1. makecode（VM 还原）

```bash
node main.js makecookie -f ts.json -j vm.js   # 必须本地文件模式
# 坑: -u 自抓会崩在工具自身 HTTP; 路径不能含空格; -j 传相对文件名
```

### 2. tscd 通过 + 外层 Feistel 解密

- tscd 任务还原通过（410 任务树），keys[2]/[16]/[17] 与真实 VM 逐位一致
- 外层解密自检 bug：`uuid == CRC32(nextarr[4:])`（工具原查整个数组 → 恒 MISMATCH）
- 真实 nextarr 布局：`[uuid(4), 2, 8, r2mkaTime(4), startTime(4), 48, keys2(48), hd(128), len, basearrEncrypt(N)]`

### 3. 内层解密（本库首次全通）

```
basearrEncrypt = Feistel-CBC(xor(Huffman(basearr), keys2[:16]), numarrAddTime(keys[17], runTime, ele)[0], flag=0)
```
- 逆向参数锁定：**keyIdx=17, ele=1**（ele ∈ [1,256] 暴力 × 域名字节验证）
- Huffman 树**静态**（255×1 + 255×6 + 0×45 权重），可自检往返
- MITM 查表需模块级缓存（4×65k 插入每块重建 = 15 分钟 → 缓存后秒级）

### 4. 真实 basearr = 173 值（vs len127 的 127）

块结构（numarrJoin 对数组段自动插长度前缀）：
`[3,70,<70>] [10,35,<35>] [7,12,<12>] [0,1,<1>] [6,16,<16>] [4,15,<15>←本站新增块] [2,4,<4>] [9,1,<1>] [13,1,<1>]`

### 5. 字段来源映射（同轮多配置差分）

一轮 412 → 8 次 env 运行（UA×platform×2 重复）→ 内层解密 → 逐位分类：
156 常量 / 9 随机 / 4 UA / 3 platform / 密钥派生位（同轮恒定、跨轮变化）

| 位置 | 来源 |
|------|------|
| [6-9] | uuid(UA) |
| [11-15] | platform 串（[10]=长度） |
| [18-21]、[85-91] | 随机 |
| [76-79] | r2mkaTime（**必须当前 epoch**，服务端校验新鲜度） |
| [80-83] | keys19 num4 |
| [121-122] | codeUid（getCodeUid 任务提取） |
| [134-135] | encryptMode2(decrypt(keys22)) 原始输出 [16:18] |
| 块2 | fixedValue20() 任务树提取 |

### 6. Cookie 组装修复（412 → 400 → 200 的关键）

- **nextarr 用 spread 拼接**：`[...numarrJoin(2, times(8), keys2(48)), hd, len, ...enc]`——numarrJoin 的自动长度前缀就是真实的 8/48 标记，外层再用 numarrJoin 会多插段长前缀
- **hd 字节恒写**（encLen>>8|128，非 debugger 专属）、len 字节 = encLen 低字节
- **r2mkaTime = 当前 epoch**（原 keys[21] 派生值过时）

## 四、避坑记录

1. **同轮配对**：ts.json/vm.js/O/P 必须同一 412 轮（keys 依赖 cd，每轮随机）
2. **cookie 后缀 = T**（`lastWord: 'T'` 与 rs-reverse 约定一致；验证时 T/P 轮换兜底）
3. **服务端不校验 basearr 域名**（环境模板硬编码的他站域名照样 200）——但结构（块布局/标记）严格校验
4. **400 ≠ 失败**：400 = 结构被识别但字段错（比 412 更接近成功）；412 = 整体拒收
5. **国密证书**：curl_cffi 必须 `verify=False`；Node 侧 `NODE_TLS_REJECT_UNAUTHORIZED=0`

### sdenv 补环境的坑（2026-08-19 打通记录）

6. **不要删 `window.escape`**：早期为绕过反机器版的 escape 门控死循环，模板里习惯性 `window.escape=undefined`。但 2026-08-19 后服务器统一分发友好版（jj8pkMDMKUcA.43ade2a.js，无门控），**友好版 IIFE 反而需要 `window.escape`**：eval 的 294KB IIFE（`_$i1`=scj 池、`_$i4`=aebi 池，顶层 while 解释 aebi[0] 字节码）在 opcode 299 `_$g8=_$f$(_$iO[9])` 处取 `window.escape`，随后 opcode 178 `_$a5=_$kn||(_$g8||...)` 用其 truthiness 决定走正常/异常分支——escape 缺失 → `_$a5=false` → 跳转异常路径 → IIFE 早退（62ms）→ 无 P cookie。
   - 症状对照：正常 IIFE 完整执行 274ms（manual）/339ms（jsdom+插桩），`$_ts.scj/aebi` 被消费清成 undefined；异常路径 46-62ms 早退，scj 保持 `[]`、aebi 保持 6 数组
7. **meta(arg1) 必须注入**：jsdom 的 `beforeParse` 里 `document.head` 为 null，要在 `jsdomFromText` 返回后、`runInContext` 前用 `createElement('meta')` + `id`/`content`/`r='m'` 属性注入
8. **O cookie 需同轮预置**：jsdom 里 `document.cookie = <412 轮 O cookie>`（curl_cffi session 自动持有，名称 S 结尾，P 名称 = S 名去尾 + T）

## 五、文件清单

| 文件 | 说明 |
|------|------|
| `spider_rs_pure.py` | 纯算法主脚本（同轮抓料 + makecookie + T/P 验证） |
| `patch_rs_reverse_tj.py` | 一键补丁（上游 bug×2 + lenTj 适配器 + Cookie.js 修复 + 运行时配置） |
| `lenTj.js` | 站点适配器（173 值 basearr 完整重建，动态位全定位） |
| `spider_manual_env.py` | 手写补环境备用方案 |
| `browser_envs_v3.js` | 补环境模板（setFuncNative 37+ 函数 + 异步 timer + process 隐藏） |
| `spider_sdenv_tj.py` | sdenv 补环境主脚本（curl_cffi 抓料 + node 生成 cookie + 验证） |
| `generate_cookie_tj.js` | sdenv 模板（jsdomFromText + meta 注入 + O cookie 预置 + escape 保留） |
| `tj_200.html` | 200 页面样本 |

## 六、打包验证（2026-08-19，从本目录复测）

- ✅ 1/1 轮 200（10592B SPA 壳），cookie 321 字 `LmqtOhuon8XET`，总用时 7.5s（含网络往返）
- `spider_rs_pure.py` 用 `require.resolve('rs-reverse')`（cwd 向上查找）→ 实测解析到主目录全局安装 `~/node_modules/rs-reverse`
- **全局副本可能为"半修复"状态**（不同上游版本）：本机副本 r2mkaTime 已是 epoch ✅，但 nextarr 仍是旧结构（hd 字节仅 `adapt.hasDebug` 时写）→ 补丁脚本 v2 已兼容两个上游变体锚点，幂等重跑即自愈
- sdenv-extract 缺失只影响 `makecode`（不参与 `makecookie` 流程），本方案无需安装

### sdenv 路线验证（2026-08-19 晚，从本目录复测）

- ✅ **2/2 轮 200**（10612B/10623B 电子税务局 SPA 壳），每轮 ~17-19s（含 12s timer 等待），cookie 482 字（O 178 + P 304）
- 关键修复：`generate_cookie_tj.js` **不删 `window.escape`**（opcode 178 分支依赖，详见避坑 6）；`window.escape=undefined` 绕行残留是 sdenv 长期失败根因
- 运行时产物在 `output/`（challenge.html / vm.js / ck_sdenv.txt / tj_200_sdenv.html）
