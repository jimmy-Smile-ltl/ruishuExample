# 站点E（研究院）— 瑞数 WAF 逆向示例

目标站：`aHR0cHM6Ly93d3cuY2FpY3QuYWMuY24va3h5ai9xd2ZiL2Jwcy8=`（base64，解码见文末）

防护：**瑞数**（412 挑战 + O/P 双 Cookie + JSVMP 双层 VM + 环境检测）

> 匿名化说明：站名使用代号（站点E），目标 URL 为 base64 编码。
> 解码：`echo <b64> | base64 -d`（bash）/ `[Convert]::FromBase64String("<b64>")`（PowerShell）。

## ✅ 站点现状（2026-08-19 实测更新）

**站点E 仍是瑞数 WAF，脚本可用**。此前"已弃用瑞数 / 换网神 WAF"为**误判**：
空 404 + `wzws-ray` 头 = WAF 临时限流（491）的表现，几小时后恢复 412 + `$_ts` 挑战。

- 2026-08-19 晚实测：`spider_jsdom_sync.py` 全流程 **412 → P 407 chars → 200**（9.3s）
- 生成器离线验证：421 chars document.cookie / 407 chars P-cookie，与生产一致
- ⚠️ **限流提示**：连续请求（尤其快速重试）会触发 491，等待 30 分钟-数小时恢复；
  不要用脚本做高频轮询验证

## 挑战流程

```
① GET 目标页 (无 cookie)
     ← 412 + Set-Cookie: <随机名>O (HttpOnly) + [meta r='m' 编码数据] + [$_ts.nsd/cd] + [VM 解释器 JS]
② GET VM 解释器 JS (241KB, 30 天缓存)
③ 浏览器执行 VM → 解码 $_ts.cd 字节码 → 环境检测 → 计算 → 设置 <随机名>P cookie
④ GET 目标页 (带 O+P cookie)
     ← 200 (有效) / 400 (cookie 无效)
```

站点E 版瑞数 VM 有**加强环境检测**（eval direct 语义检测、debugger 检测、
DOM 集合类型检测、数组膨胀惩罚），比基础版（常见于普通政企站）难一个量级。

## 可行方案（2026-08-19 晚实测）

| 方案 | 文件 | 依赖 | 实测结果 |
|------|------|------|---------|
| **2. jsdom + 同步 flush（推荐）** | `spider_jsdom_sync.py` + `jsdom_gen.js` | curl_cffi + Node + sdenv | ✅ **08-19 晚在线 200**（421 chars P 秒出）；生成器离线验证 407 chars P 与生产一致 |
| 1. sdenv jsdom 补环境（真实 timer） | `spider_sdenv.py` | 同上 | ✅ 343 chars P / 200（历史实测，等 8s） |
| 3. CloakBrowser 隐身浏览器 | `spider_cloakbrowser.py` | cloakbrowser | ✅ 浏览器原生 Cookie / 200（历史实测 ~83% 成功率） |

三个脚本均独立可运行，成功后保存 `site_e_200_{方案}.html`。

三个脚本均独立可运行，成功后保存 `site_e_200_{方案}.html`。

### 方案 1：sdenv（纯算，无浏览器）

curl_cffi 拿 412 页 + O-cookie → Node 里 sdenv 的 jsdom 加载 412 页并执行瑞数 VM
→ 等 8s 真实 timer → `document.cookie` 出 P-cookie → 同 session 带 O+P 重请求 200。

关键点：`beforeParse` 里 try/catch 包裹 setTimeout/setInterval 回调——缺失 API 不崩溃。

### 方案 2：jsdom + 同步 flush（方案 1 的升级版，推荐）

决定性实验（`jsdom_hybrid`）证明：**环境是关键，timer 时序无关**——
jsdom 环境里把 setTimeout/setInterval 改成"收集回调 + 同步 flush"，
不破坏瑞数 VM 状态机，且 cookie 更长（421 vs 343 chars）、秒出（无需等 8s）。

```
| 方案              | 环境   | timer      | 结果                 |
|-------------------|--------|------------|----------------------|
| sdenv (方案1)     | jsdom  | 真实(等8s) | 343 chars ✅          |
| 纯手写环境        | 手写   | 同步 flush | Invalid array length ❌ |
| jsdom+同步flush   | jsdom  | 同步 flush | 421 chars ✅ 秒出     |
```

### 方案 3：CloakBrowser

隐身 Chromium（C++ 补丁，58 指纹修正）直接加载页面，瑞数挑战自动完成，
`page.context.cookies()` 提取双 Cookie。列表页首次命中率 ~20%，脚本内建 15 次重试。

## 已验证失败的路线（避坑）

| 路线 | 现象 | 原因 |
|------|------|------|
| 纯手写 VM 补环境 | `RangeError: Invalid array length`，只有 enable 测试 cookie | 站点E VM 有**加强检测链**（eval direct 语义 / debugger / collection.item / document 属性）。检测分叉 → 字节码流错位 → 字符串表解码出无效索引 → 惩罚路径循环 push 到 2^27 → 撞 V8 FixedArray 硬上限。手写环境无法对齐深层结构（函数 realm / 原型链 / DOM 集合类型） |
| 纯算法还原 | 需完整重写加密引擎 | VM 字节码 + 雪崩效应，工作量不实际 |
| 覆盖 env.eval | 检测触发 → 分叉 | `new function(){eval("this.a=1")}().a` 检测 direct eval 的 this 绑定；wrapper 变普通函数调用 → 检测失败。必须留 V8 原生 eval |
| Node 原生 TLS 直连 | ECONNRESET | 站点E 校验 TLS 指纹，必须 curl_cffi `impersonate="chrome110"` |

## 依赖安装

```bash
# 方案 1/2
pip install curl_cffi
npm install sdenv          # 在 site_e_enhanced 目录执行（Windows 需先装 Windows 10 SDK 编译原生模块）

# 方案 3
pip install cloakbrowser   # 首次运行自动下载 stealth Chromium (~200MB)
```

## 通用经验

- **环境是关键，timer 时序无关**：瑞数 VM 的状态机不依赖真实定时器时序，
  同步 flush 可大幅提速 sdenv 类方案（8s → ~2s）。
- **指纹一致性 > 真实性**：HTTP UA == navigator.userAgent（两边同一个 UA 常量），
  服务端只验证内部一致性。
- **触发函数报错 = 正常**：挑战脚本后半段是页面跳转逻辑，找不到 DOM 节点就崩，
  此时 P-cookie 已生成，判断成功只看 cookie jar。
- **手写补环境有天花板**：基础版瑞数纯手写即可过；
  加强版（站点E 类）必须 jsdom 级完整环境。
- **用前先确认站点仍是瑞数**：412 + `$_ts` 特征即有效；若偶发空 404 + `wzws-ray`
  头，先等 30 分钟-数小时再试（WAF 限流误判），不要急着下"换 WAF"结论。
