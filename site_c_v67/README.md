# 站点C（医院）— 瑞数 WAF 逆向示例

目标站：`aHR0cHM6Ly9zdWdoLnN6dS5lZHUuY24vSHRtbC9OZXdzL01haW4vMTAyLmh0bWw=`（base64，解码见文末）（新闻中心，ASP.NET/IIS）

防护：**瑞数 v6/v7**（JSVMP 双层编码 + 412 挑战），整站所有动态路径受保护。

> 匿名化说明：站名使用代号（站点C），目标 URL 为 base64 编码。
> 解码：`echo <b64> | base64 -d`（bash）/ `[Convert]::FromBase64String("<b64>")`（PowerShell）。

## 挑战流程

```
① GET 目标页 (无 cookie)
     ← 412 + Set-Cookie: <随机名>O (HttpOnly) + [meta 编码数据] + [$_ts 初始化] + [VM 解释器 JS]
② GET VM 解释器 JS (~300KB, 30 天缓存)
③ 浏览器执行 VM → 解码 $_ts.cd 字节码 → 计算 → 设置 <随机名>P cookie → 自动重载
④ GET 目标页 (带 O+P cookie)
     ← 200 (有效) / 400 (cookie 无效)
```

注意：cookie 名每次挑战**随机生成**（如 `<随机名>O/P`...），
且真实浏览器一次会话会积累**多组**不同名字的 O/P 对（每轮挑战一组）。

## 可行方案（2026-08-13 实测）

| 方案 | 文件 | 依赖 | 实测耗时 | 结果 |
|------|------|------|---------|------|
| 1. sdenv jsdom 补环境（无浏览器） | `spider_sdenv.py` | curl_cffi + Node + sdenv | ~14s（8s 等 cookie） | ✅ 200 + 43 链接 |
| 2. DrissionPage 过挑战 + cookie 复用 | `spider_drission.py` | DrissionPage + curl_cffi + Chrome | ~4s | ✅ 200 + 43 链接 |
| 3. 原生 CDP 零注入 + cookie 复用 | `spider_cdp.py` | websocket-client + curl_cffi + Chrome | ~3s | ✅ 200 + 43 链接 |
| 4. Camoufox 反检测浏览器 | `spider_camoufox.py` | camoufox | ~18s | ✅ 200 + 43 链接 |
| **5. 手动补环境（纯 Node，无浏览器，★ 2026-08-15 v3 翻盘）** | `spider_manual_env.py` + `env/browser_envs.js` | curl_cffi + Node（零 npm 依赖） | **~3s** | ✅ 压测 20/20 轮 200 + 27/27 文章 || **6. iv8 运行时（pip C++ 环境，★ 2026-09-05 新首选）** | `spider_iv8.py` | Python 原生 V8 + C++ DOM（零 npm） | **1-4s** | ✅ 200（新闻中心页） |


六个脚本均独立可运行，`python spider_xxx.py` 成功后在当前目录保存 `site_c_200_xxx.html`。

### 方案 1：sdenv（纯算，无需浏览器）

curl_cffi 拿 412 页 + O-cookie → Node 里 sdenv 的 jsdom 完整加载 412 页并执行瑞数 VM
（`resources: 'usable'` 让 VM JS 由 jsdom 自己加载）→ 8s 后 `document.cookie` 出 P-cookie
→ 同 session 带 O+P 重请求 200。

关键点：`beforeParse` 里 try/catch 包裹 setTimeout/setInterval 回调 —— 缺失 API 不崩溃。

### 方案 2：DrissionPage（最简单）

系统 Chrome 加载页面，瑞数挑战在真实浏览器里自动完成（~3s），
`page.cookies(all_domains=True)` 提取全部 cookie（含 HttpOnly 的 O 和各随机名 P 对），
之后全部请求用 curl_cffi 复用 cookie，不再需要浏览器。

### 方案 3：原生 CDP 零注入（最快最稳）

命令行启动真实 chrome.exe 后通过 CDP 接管。**配方四要素**（5/5 大学站实测）：

1. 真实 chrome.exe + `--headless=new` + `--user-agent=Chrome/138`
2. **零 JS 注入** —— 不注入任何 stealth 脚本。瑞数 VM 会检测 navigator
   属性描述符被篡改（值→getter），静默放弃出 cookie → 重载被 400
3. 导航用 renderer 跳转 `Runtime.evaluate("location.href=...")`，不用 `Page.navigate`
4. Chrome 151+ 必须带 `--remote-allow-origins=*`；`--user-data-dir` 必须绝对路径

### 方案 4：Camoufox

反检测 Firefox（引擎级指纹伪装）直接加载，挑战自动完成，提取 cookie 复用。

### 方案 5：手动补环境（纯 Node，无浏览器）

curl_cffi 拿 412 页 + O-cookie → 提取 meta/`$_ts` 初始化脚本/VM JS → 注入 `env/browser_envs.js`
手动补环境模板 → Node 执行 → P-cookie → 同 session 200。

**关键坑（2026-08-15 攻克）**：
1. **定时器必须异步 + try/catch** —— 同步 flush 会跳过 VM 的 timer 驱动阶段，
   basearr 少 30 字节（P 257 vs 343 chars）被服务端 412 拒收。异步后 1s 即出完整 cookie
2. **Location 必须与目标站一致** —— hostname 编进 basearr 加密，服务端校验内部一致性
3. `document.all` 的 `toString()` 要返回 `"[object HTMLAllCollection]"`
4. Node 脚本尾部必须 `process.exit(0)`（VM 的 setInterval 会挂住进程）

完整原理讲解（分层结构、四个关键坑、调试方法论、移植要点）见 [方案5_手动补环境详解.md](方案5_手动补环境详解.md)。

**坑**：camoufox 的 sync_api 在 `close()` 后会把 running event loop 泄漏在主线程，
同进程内后续启动任何 Playwright sync 引擎会报
`Playwright Sync API inside the asyncio loop`。修复：

```python
import asyncio
asyncio._set_running_loop(None)          # 清泄漏（Runner.close 内部同款）
asyncio.set_event_loop(asyncio.new_event_loop())
```

### 方案 6：iv8 运行时（pip C++ 环境，无浏览器·免 npm·免算法）

```bash
pip install iv8 requests
python spider_iv8.py      # 412 → iv8 VM → 200
```

- iv8（github.com/HanZzzzz000/iv8，社区版非商用许可）把浏览器环境做在 C++ 层，
  瑞数 VM 直接执行出 cookie，回放即 200（2026-09-05 实测 1-4.3s）
- 比手动补环境还少一层「手写环境」的心智负担：环境是引擎原生实现，无需逐键对齐

## 已验证失败的路线（避坑）

| 路线 | 现象 | 原因 |
|------|------|------|
| 纯 Node 通用补环境（`browser_envs.js` 模板） | P-cookie 能生成（326 chars）但重请求永远 412，多轮重试不收敛 | P **值**无效——补环境缺检测项导致 cookie 内容错误，被服务端拒收。对比：sdenv 只凭一对 O+P 也能过，说明不是"缺 cookie 对"的问题 |
| CloakBrowser（stealth Chromium） | 完整走完 412→VM→重载 400 | 源码补丁二进制被瑞数 VM 指纹检测识别；关 stealth args、有头模式均无效 |
| 多轮重试单 cookie 对 | 每轮都是新 412 | 同纯 Node 路线；且每轮 meta/VM 字节码随机，偶发 P-cookie 生成失败 |

## 依赖安装

```bash
# 方案 1
pip install curl_cffi
npm install sdenv          # 在 site_c_v67 目录执行

# 方案 2
pip install DrissionPage curl_cffi

# 方案 3（需系统安装 Chrome）
pip install websocket-client curl_cffi

# 方案 4（首次运行自动下载浏览器）
pip install "camoufox[geoip]"
```

## 通用经验

- **浏览器层真实 > JS 层伪装**：对瑞数这类 VM 风控，真实 Chrome/Firefox 过挑战的可靠性远超任何补环境。
- **cookie 复用**：过挑战后把 cookie jar 整体给 curl_cffi（UA 与浏览器一致 + `impersonate="chrome110"`），后续爬取秒级完成，不用一直挂着浏览器。
- **排查全线 400 时**：curl_cffi 复刻同一请求头拿 412 可快速排除请求头因素；若浏览器也 400，检查是否注入过 stealth 脚本。


## 方案 5 v3 升级记录（2026-08-15）

原手动补环境 WAF 升级后曾失效（P-cookie 被 412 拒）。结合站点D 的手写补环境
v3 成果三件套翻盘：

1. **setFuncNative 原生伪装层**：原模板 func_set_native 定义了 0 个调用点（死代码），
   VM 逐个函数 toString 检测裸奔 → 补全 ~45 函数 + eval 33 chars 伪装
2. **VM 执行期隐藏 process**（node 环境检测）——注意模板的 delete global.global
   在 VM 执行之后，IIFE 包装用 globalThis
3. **meta id 轮换兼容**：按 r='m' 定位，不再硬编码具体 meta id

生产爬虫 `spider_manual_prod.py`：文章列表 + 详情 + CSV 落盘 + 412 自动恢复，
实测 27/27 篇 19.1s。
