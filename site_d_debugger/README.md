# 站点D（药品监管部门）— 瑞数 WAF 逆向示例

目标站：`aHR0cHM6Ly93d3cubm1wYS5nb3YuY24v`（base64，解码见文末），含数据查询模块 `/datasearch/`

防护：**瑞数 WAF（多阶段挑战）**，全站动态路径受保护。数据查询模块挑战比首页更严（两轮 412）。

> 匿名化说明：站名使用代号（站点D），目标 URL 为 base64 编码。
> 解码：`echo <b64> | base64 -d`（bash）/ `[Convert]::FromBase64String("<b64>")`（PowerShell）。

## 挑战流程（2026-08-13 CDP 实测诊断）

```
① GET 目标页 (无 cookie)
     ← 412 + Set-Cookie: <随机名>O (HttpOnly) + [meta 编码数据] + [$_ts.nsd/cd 初始化]
       + [内联触发函数 _$$k()/_$_s()/_$_x()... 每次轮换] + [VM 解释器 JS ~233KB]
② 执行 VM → 解码 $_ts.cd 字节码 → canvas 指纹 → 计算 P-cookie → location.replace 回原 URL
③ GET 目标页 (带 O+P)
     ├─ 首页:        → 200 ✅ (单轮挑战)
     └─ /datasearch/: → 412 第二轮 (新 meta + 新 httpOnly cookie) → 再执行 VM → 200 ✅
```

关键特征：

- **触发函数名每次轮换**：`_$$k` / `_$_s` / `_$_x` / `_$mj` ...（正则需通用匹配）
- **cookie 名动态**：O 族（HttpOnly，服务器下发）+ P 族（VM 生成），每轮挑战换名
- **TLS 绑定**：cookie 与 TLS 指纹绑定，curl_cffi `impersonate="chrome110"` 兼容
- **多阶段**：/datasearch/ 是两轮 412（补环境只跑单轮必失败——旧方案死因）

## 可行方案（2026-08-13 ~ 08-15 实测）

| 方案 | 文件 | 依赖 | 实测耗时 | 结果 |
|------|------|------|---------|------|
| 1. sdenv 链式补环境（无浏览器） | `spider_sdenv_chain.py` + `stage_vm.js` | curl_cffi + Node + sdenv | ~4s/页 | ✅ 首页 + 数据查询 + 搜索结果全 200 |
| 2. 原生 CDP 零注入（最快，需 Chrome） | `spider_cdp.py` | websocket-client + Chrome | ~2-5s/页 | ✅ 全页面 200 |
| 3. rs-reverse 纯算法（★ 零浏览器零环境模拟） | 🔒 代码不开源（文档见下 + `纯算法攻克思路.md`） | curl_cffi + Node + rs-reverse | ~1-4s/轮 | ✅ 200（2026-08-15 攻克） |
| 4. 手写补环境 v3（Node 零依赖） | `spider_env_v3.py` + `build_env.js` + `native_patch.js` | 仅 curl_cffi | ~2-8s/轮 | ✅ v2 稳定化后 10/10 轮通过（同轮多跑 + 双复验） |
| 5. 手写 harness + browser() 直调 | `spider_handpatch.py` + `build_env_browser.js` | curl_cffi + Node + sdenv(仅补丁函数) | ~5-8s/页 | ✅ 三页全 200（2026-08-15 攻克） |
| 6. RPC 直达 pajax 数据层（★ 数据采集首选） | `spider_rpc.py` | websocket-client + Chrome | ~0.2s/页 | ✅ 阿莫西林 572 条/58 页全通 |

方案 1-6 均独立可运行（方案 4 用 v2 稳定化：同轮多跑 + 双复验）。

### 方案 1：sdenv 链式补环境（纯算 + jsdom，无浏览器依赖）

```
curl_cffi (chrome110) 负责所有 HTTP (TLS 一致)
  ├─ GET → 412 + O-cookie → 保存 412 HTML (临时文件)
  ├─ node stage_vm.js (jsdomFromText 本地跑 VM) → P-cookie (~2.5s 早停)
  └─ 组合 O+P 下一轮, 直到 200 (最多 3 轮, 412 自动续轮)
```

关键点：

1. **`jsdomFromText` 替代 `jsdomFromUrl`**：sdenv 的本地 HTML 执行 API，环境质量相同
   （sdenv 原生 canvas/WebGL 模块 + 浏览器补丁），但 HTML 来自 curl_cffi，
   TLS 与最终请求天然一致
2. **链式续轮**：多阶段挑战每轮 = 一次请求 + 一次 VM 执行，412 就续轮（最多 3 轮）
3. **早停**：轮询 document.cookie ≥100 chars 且连续 2 次稳定即结束（实测 ~2.5s/轮）
4. **`beforeParse` 里 try/catch 包裹 timer**：缺失 API 不中断 VM cookie 生成链
5. **阻止 `location.replace`**：让 VM 在当前上下文完成 cookie 生成，跳转由 Python 层控制

安装（sdenv 需 node-gyp + VS C++ 编译环境）：

```bash
pip install curl_cffi
npm install        # 在本目录
```

运行：

```bash
python spider_sdenv_chain.py                  # 首页 + /datasearch/ + 搜索结果页
python spider_sdenv_chain.py --url <URL>      # 单 URL
```

### 方案 2：原生 CDP 零注入（真实 Chrome，最快最稳）

配方四要素（pro36 五所大学站 5/5 实测，本目录 `spider_cdp.py` 为最小化独立版）：

1. 真实 chrome.exe + `--headless=new` + `--user-agent=Chrome/138`（UA 与站点风控规则对齐）
2. **零 JS 注入** — 任何 `addScriptToEvaluateOnNewDocument` stealth 脚本都会改 navigator
   属性描述符（值→getter），瑞数 VM 检测到篡改后静默放弃出 cookie
3. 导航用 renderer 跳转 `Runtime.evaluate("location.href=...")`，不用 `Page.navigate`
4. Chrome 151+ 必须带 `--remote-allow-origins=*`；`--user-data-dir` 必须绝对路径

多阶段挑战在真实浏览器里自然完成（redirect 真实发生），无需干预。

```bash
pip install websocket-client psutil
python spider_cdp.py                           # 首页 + /datasearch/ + 搜索结果页
python spider_cdp.py --url <URL>
```

### 方案 3：rs-reverse 纯算法（零浏览器、零环境模拟，2026-08-15 攻克）

> 🔒 **开源策略**：纯算法可运行代码（`spider_rs_pure.py` / `patch_rs_reverse_site_d.py` /
> `_runTask_hoist_v7.tpl.js`）**不开源**（防被直接用于大规模未授权采集），
> 技术思路全部公开于本文与 [纯算法攻克思路.md](纯算法攻克思路.md)。

```
curl_cffi (chrome110) 拿 412
  ├─ ts.json (★ hasDebug:true, 站点D 是 debugger 变体 hd 位 0x80) + vm.js + O-cookie
  ├─ node rs-reverse makecookie → 纯算法还原 VM 字节码 → P-cookie (~1-2s)
  │     └─ len160 适配器 (patch 注入): 实测真实 basearrEncrypt=160, 随机字节段 155
  └─ O+P 组合, 名后缀 T/P 轮换验证 → 200 (首次偶发 412 自动重试)
```

站点特性与对策：

1. **VM 变体轮换**：约 2/3 挑战轮的任务执行会崩（cp2 数字表缺函数项），
   自动换新挑战轮重试（实测通常 1-3 轮内成功）
2. **cookie 名后缀 T/P 轮换**：按挑战轮次变化，验证时两种名都试
3. **hasDebug 必须**：ts.json 缺 hasDebug 字段时任务执行必崩

```bash
# 纯算法代码未开源（见上方开源策略）；以下仅为记录已验证的调用链
pip install curl_cffi && npm install rs-reverse
# python patch_rs_reverse_site_d.py   # len160 适配器 + 6 项补丁 (含 v7 提升器)
# python spider_rs_pure.py            # 数据查询页 (默认)
```

补丁清单（patch_rs_reverse_site_d.py，2026-08-15 v7）：

1. sdenv-extract Windows 路径补丁
2. globalVarible.js `_ts` getter（makecode-high 路径必崩）
3. **len160 basearr 适配器**（真实 basearrEncrypt=160，随机字节段 98→155）
4. makeCookie.js 全量动态代码存储（`gv.config.code`）
5. runTask.js `global_res` 函数绑定优先 + 缓存（框架作者"cp2 数字表"假设被站点D 新 VM 打破）
6. runTask.js **函数声明预提升 v7**（词法级扫描：注释/字符串/模板串/正则感知 + IIFE 顶层 var 提升）——消除 `_$fq is not defined` / `_$no is not a function` 两类崩溃，成功率 ~1/3 → **~75%**（剩余 25% 为深层栈分叉，重试兜底）

### 方案 5：手写 harness + browser() 直调（脱离 jsdomFromText 流程，2026-08-15 攻克）

```
curl_cffi (chrome110) 负责所有 HTTP
  ├─ GET → 412 + O-cookie → 保存 412 HTML + VM 文件
  ├─ node build_env_browser.js (JSDOM + browser(w,'chrome') 补丁直调) → P-cookie
  └─ O+P 组合 → 重新请求 → 200
```

配方五要素（三轮探索的最终结论）：

1. `runScripts: 'dangerously'` + `resources: 'usable'` — VM 必须在 jsdom parse 阶段执行
2. `browser(w, 'chrome')` + `getHandle('window')({})` — sdenv 补丁层 + 代理 realm（拦截 vm.runInContext）
3. **★ VirtualConsole 吞 jsdomError** — 泄漏的脚本错误经 window.onerror 污染 VM 流程，
   还把 `[Error]` 垃圾写进 cookie jar（此前 400 的直接原因）
4. cookieJar + userAgent + pretendToBeVisual — 与 sdenv wrap 同配置
5. 拦截 location.replace/assign — redirect 由链式层控制

```bash
npm install sdenv  # 或使用全局/上级 node_modules
python spider_handpatch.py                  # 首页 + /datasearch/ + 搜索结果页
python spider_handpatch.py --url <URL>      # 单 URL
```

### 方案 6：RPC 直达 pajax 数据层（数据采集首选，0.2s/页）

```
真实 Chrome (持久 profile + 零注入 + renderer 跳转)
  └─ 页面内 Runtime.evaluate 直接调 pajax.hasTokenGet(api.queryList, params)
       └─ 签名 7QBHXKaZ 由页面 token 层自动生成, token 绑定浏览器会话 → 免逆向
       └─ awaitPromise 直接返回 JSON (0.2s/页), 翻页直接改 pageNum
```

要点：

1. **签名免逆向**：搜索 API 的 `7QBHXKaZ` 参数由页面 token 层（`pajax.hasTokenGet`）
   自动生成，token 与浏览器会话绑定（重放 400）——在页面内调用即天然合法，
   纯算法逆向该签名不划算
2. **WAF 限流对策**：每会话 ~25 次 API 后开始失败（no-data/空页），
   内置 pace≥1.2s + 失败重载恢复 + `--fresh`（全新 profile）+
   `--proxy`（Clash 7897 换出口 IP）；生产每 ~20 页换 profile/节点，15-30min 冷却
3. **参数**：`{itemId, isSenior:'N', searchValue, pageNum, pageSize}`；
   返回 `{total, pageSize, list:[f0 批准文号, f1 产品名称, f2 生产单位, f3 本位码, f4 记录ID]}`
4. **静态分析附注**：search-result.js 明文可读（queryList 参数直接可见）；
   api.js 为 XOR(9) 混淆（端点已解）；ajax.js 为 jsjiami v6 混淆（无需解，token 层已封装）

```bash
pip install websocket-client
python spider_rpc.py 阿莫西林                    # 单关键词全量翻页
python spider_rpc.py --file keywords.txt         # 批量关键词
python spider_rpc.py 阿莫西林 --max-pages 3 --fresh --proxy http://127.0.0.1:7897
```

---

## 验证结果（2026-08-13 ~ 08-15 连续实测）

```
方案 1: 首页 PASS (4.1s, 52682b)  数据查询 PASS (3.9s, 25124b)  搜索结果 PASS (会话复用)
方案 2: 首页 PASS (4.6s, 67831b)  数据查询 PASS (1.5s, 17476b)  搜索结果 PASS (1.4s)
方案 3: 数据查询 PASS (25128b, 257-char P-cookie)  复验 200×2 + 错误名对照 412
方案 4: 数据查询 10/10 轮稳定通过 (v2 同轮多跑, 平均 2.3 跑/轮, 200 双复验)
方案 5: 首页 PASS (7.9s, 52573b)  数据查询 PASS (4.7s, 25195b)  搜索结果 PASS (0.1s, 会话复用)
方案 6: 数据查询 RPC 直达 PASS (0.2s/页, 阿莫西林 572 条/58 页全通)
```

判定标准：搜索页（/datasearch/）通过才算通过 —— 六方案均满足。

## 文件

| 文件 | 说明 |
|------|------|
| `spider_sdenv_chain.py` | 方案 1 主入口：curl_cffi 链式 + 调用 stage_vm.js |
| `stage_vm.js` | 单轮挑战执行器：jsdomFromText 本地跑 VM 输出 P-cookie |
| `package.json` | Node 依赖声明（sdenv ^1.1.3） |
| `spider_cdp.py` | 方案 2：原生 CDP 零注入最小独立实现 |
| `spider_rs_pure.py` | 🔒 方案 3：rs-reverse 纯算法爬虫（**不开源**，仅本地保留） |
| `patch_rs_reverse_site_d.py` | 🔒 方案 3 前置：len160 适配器 + 6 项补丁（**不开源**） |
| `_runTask_hoist_v7.tpl.js` | 🔒 补丁 6 的提升器模板（**不开源**） |
| `spider_env_v3.py` | 方案 4：手写补环境 v3 爬虫（v2 稳定化：同轮多跑 + 双复验） |
| `build_env.js` + `native_patch.js` | 方案 4 的 Node 侧：手写 mock + 原生伪装层（setFuncNative） |
| `spider_handpatch.py` | 方案 5 主入口：curl_cffi 链式 + 调用 build_env_browser.js |
| `build_env_browser.js` | 方案 5 执行器：JSDOM + browser(w,'chrome') 直调（脱离 jsdomFromText 流程） |
| `spider_rpc.py` | 方案 6：RPC 直达 pajax 数据爬虫（自包含 CDP 客户端，零注入 + awaitPromise） |
| `rpc_profile/` | 方案 6 运行时的 Chrome 持久 profile（自动生成） |
| `纯算法攻克思路.md` | 方案 3 完整技术思路：诊断链、同轮对比法、len160 推导、方法论总结 |
| `cdp_profile/` | 方案 2 运行时的 Chrome 持久 profile（自动生成） |

## 已知边界

- 首页与数据查询模块 cookie 族不同（`<随机名>S/T` vs `<随机名>O/P`），会话内跨页请求正常（复用同一 session）
- 手写补环境（纯 Node 零依赖）在站点D 需 v2 稳定化（同轮多跑换校准值 + 双复验防假通过）——服务器校验窗口窄，单跑是 ~50% 彩票（假通过风险）；窗口宽的站（如 pro8）单跑即稳
- sdenv npm 安装需编译原生模块（Windows 需 VS2022「使用 C++ 的桌面开发」+ Python）

## 附录：旧版搜索接口 sign 算法（2025-11 历史参考）

CSDN 文章（2025-11，旧 VM 时代）记录的搜索接口签名：

```
sign = MD5(urlencode(params + "&nmpasecret2020", safe=''))
```

- 请求头 timestamp 必须与 sign 内时间戳一致
- params 必须明文；追加 `7QBHXKaZ` 类后缀会 500（实测）
- **现状**：当前接口签名已由页面 token 层接管（`pajax.hasTokenGet` 自动生成，
  会话绑定不可重放）——本算法仅作历史参考，数据采集请用方案 6 RPC 直达
