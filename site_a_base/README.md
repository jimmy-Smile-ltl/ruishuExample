# 站点A（高校组）— 大学高校瑞数 WAF 绕过方案集

来源：高校组瑞数实战（原 pro36），2026-08-13 整理，**2026-08-19 复测确认**。
5 所使用瑞数 WAF 的高校官网，5 条可行方案（全部实测 5/5），最小可验证代码。

> 匿名化说明：官网 URL 为 base64 编码（站名保留中文，均为公开高校官网）。
> 解码：`echo <b64> | base64 -d`（bash）/ `[Convert]::FromBase64String("<b64>")`（PowerShell）。

## 目标站点（五校逐一）

| 高校 | 官网 (base64) | 风控特征 | 手写补环境方案（2026-09-02 实测） |
|------|--------------|---------|-----------------------------------|
| 兰州大学（985） | `aHR0cHM6Ly93d3cubHp1LmVkdS5jbg==` | 极严格 TLS | ✅ nodenv 5/5（14.0-14.4s，P=335c） |
| 四川大学（985） | `aHR0cHM6Ly93d3cuc2N1LmVkdS5jbg==` | 极严格 TLS | ✅ env_scu 锁定模板 3/3（P=279c，见 pro36/handpatch_v3） |
| 北京邮电大学（211） | `aHR0cHM6Ly93d3cuYnVwdC5lZHUuY24=` | 宽松 | ✅ nodenv 5/5（13.4-13.6s，T=250c） |
| 南京师范大学（211） | `aHR0cHM6Ly93d3cubmpudS5lZHUuY24=` | 极严格 TLS + **IP 风控** | ✅ nodenv 5/5（13.7-14.3s，T=250c） |
| 南京理工大学（211） | `aHR0cHM6Ly93d3cubmp1c3QuZWR1LmNu` | 宽松 + IP 风控 | ✅ env_njust 锁定模板 3/3（P=173c，**meta-embedded 特殊形态**，见 pro36/handpatch_v3） |

> 解码：`echo <b64> | base64 -d`（bash）/ `[Convert]::FromBase64String("<b64>")`（PowerShell）。

## 方案矩阵（实测）

| 方案 | 文件 | 通过率 | 单页耗时 | 内核/协议 | 定位 |
|------|------|--------|---------|-----------|------|
| **ruyiPage** | `spider_ruyipage.py` | **5/5** | **2-3s** | Firefox / WebDriver BiDi | 🏆 首选（每tab独立代理） |
| **CDP 零注入** | `spider_cdp.py` | **5/5** | 5-6s | 真实 Chrome / CDP | Chrome 系首选（无第三方内核） |
| sdenv 补环境 | `spider_sdenv.py` + `generate_cookie.js` | 5/5 | 13-15s | 纯 Node + curl_cffi | 无浏览器部署 |
| **nodenv 零依赖手写补环境** | `spider_nodenv.py` + `nodenv/` | **3/5 校**（兰州/北邮/南师各 5/5） | 13-14s | 纯 Node 内置（无 npm） | 无浏览器部署·零依赖（2026-09-02 15/15）；川大/南理工用独立锁定模板 |
| **iv8 运行时**（pip C++ 环境） | `spider_iv8.py` | **5/5 校** | **1.0-3.6s** ⚡ | Python 原生 V8 + C++ DOM | 🏆 无浏览器部署首选（2026-09-05 全通，比 nodenv 快约 10 倍，免算法） |
| Camoufox | `spider_camoufox.py` | 5/5* | 2-10s | Firefox / Playwright | 备胎 |
| DrissionPage | `spider_drission.py` | 5/5 | 2-128s | 系统 Chrome / CDP | 稳妥但慢 |
| **rs-reverse 纯算法（2026 变体）** | `pure_algo/spider_pure.py` + `pure_algo/rs_school_*.js` | **2/5 校**（兰州/南师各 200 实测） | ~70s/轮 | 纯 Node + curl_cffi | 密码链全还原，从零生成 P；basearr 暂由同轮 nodenv 提供（模板化后完全去 VM） |

\* Camoufox 在出口节点 IP 被站点标记时会失败（见"关键经验 2"），换节点即恢复。

## 各方案使用

### 1. ruyiPage（首选）

```bash
pip install ruyiPage
python -m ruyipage install   # 下载 Firefox 内核
python spider_ruyipage.py [--proxy http://127.0.0.1:7890] [--headless]
```

- Firefox + WebDriver BiDi 协议（非 CDP），isTrusted 原生事件，无自动化检测点
- **每 tab 一个密码代理** — 直接解决瑞数 IP 风控的节点轮换
- 安装坑：`ruyipage install` 在 Windows 可能因 Defender 锁文件报 PermissionError，
  手动解压 release zip 到 `%LOCALAPPDATA%\ruyipage\browsers\firefox-155.0a1-v1.2.58-win64\`
  （保留 zip 内自带的 `firefox` 子目录）

### 2. CDP 直连真实 Chrome（零注入配方）

```bash
pip install websocket-client
python spider_cdp.py
```

配方四要素（缺一不可）：
1. 真实 chrome.exe + `--headless=new` — TLS 指纹天然可信
2. `--user-agent=Chrome/138` — 与站点风控收录的版本对齐
3. **零 JS 注入** — 任何 stealth 注入都会破坏瑞数 VM（见"关键经验 1"）
4. renderer 跳转（`location.href`）发起导航，不用 `Page.navigate`

### 3. sdenv 补环境（无浏览器）

```bash
pip install curl_cffi
python spider_sdenv.py --url <目标URL> [--dept-url <URL>]
```

纯 Node + curl_cffi，唯一不依赖浏览器进程的方案，适合服务器部署。
核心：jsdomFromUrl + 阻止 `location.replace` 让 VM 完成 cookie 生成 + try/catch 包裹 timer 回调。

> **依赖坑（Windows）**：sdenv 含 native canvas，`npm install` 需 VS Build Tools
> （gyp 编译，无 SDK 直接失败）。本脚本已内置 **node_modules 自动探测**：
> 优先本目录，其次自动扫描 `../spider research/其他/` 下已装过 sdenv 的项目
> （pro11/pro36 等）直接复用其 node_modules——**无需本目录 npm install**。

### 3b. nodenv 零依赖手写补环境（无浏览器·零 npm 依赖，2026-09-02 新增）

```bash
pip install curl_cffi
python spider_nodenv.py --site bupt    # 覆盖 lzu/bupt/njnu（--site 三选一）
```

- 移植自 patent_cnipa 检索站 nodenv 9/9 打通方案：`vm.createContext(DONT_CONTEXTIFY)`
  + window Proxy + 键集对齐（align_*.js）+ fakePTS 三分支 toString + cookie 时间源
  fixDateMs 对齐——**零 npm 依赖**（不需要 sdenv/VS Build Tools），node ≥ 18 即可
- 覆盖 lzu/bupt/njnu 三校，15/15（bupt/njnu T=250c、lzu P=335c，13-14s/轮）
- **scu/njust 用独立锁定模板**（pro36/handpatch_v3 的 runner 框架
  env_scu/env_njust，3/3 稳定）。njust 是 meta-embedded 特殊形态（nsd/cd 编码在 meta
  content + 22.5KB 分片 VM + `_$0P('rEA5')` 初始化），nodenv 的 classic 解析暂不支持——
  统一到 nodenv 需补 meta-embedded 解析（增强项，非必需）
- 核心教训（patent_cnipa 三阶段史）：400 = 8 处环境差异（键集/navigator/matchMedia）；
  0c = env cookie setter 用宿主 Date.now 误判 VM fixdate 的 expires 为过期（写完即删）；
  200 = fixDateMs 对齐。"最后卡点往往不是 VM 环境本身，而是宿主侧逻辑"

### 3c. iv8 运行时（无浏览器·免 npm·免算法，🏆 2026-09-05 新首选）

```bash
pip install iv8 curl_cffi
python spider_iv8.py --site bupt    # 覆盖五校：lzu/scu/bupt/njnu/njust
```

- iv8 = Python 原生 V8 + C++ 层浏览器环境（`pip install iv8`，社区版非商用许可，
  github.com/HanZzzzz000/iv8）。瑞数 VM 直接在 iv8 里执行出 cookie，回放即 200
- **5/5 校全通**（2026-09-05 实测）：bupt 1.0s / njust 1.1s（202 形态）/
  njnu 1.4s / lzu 3.6s / scu 直通 200（无 WAF）——比 nodenv 快约 10 倍，
  比 sdenv 快约 10-15 倍，零 npm 依赖，且**不用逆向算法**（VM 原样执行）
- 共享工具链在仓库根 `iv8_kit/`（含 http 站 Secure 剥离 hook + 每轮全新 JSContext 等）
- 两层通用坑（海关站逼出，已沉淀 iv8_kit）：http 站 Secure cookie 被 iv8 丢弃；
  多轮挑战复用 JSContext 会状态污染（每轮须全新 context）

### 4. Camoufox

```bash
pip install camoufox
python -m camoufox fetch
python spider_camoufox.py
```

必须用 `with Camoufox(...) as browser:` 上下文（`__enter__` 才返回 browser 对象）。

### 5. DrissionPage

```bash
pip install DrissionPage
python spider_drission.py
```

`run_js` 是一次性执行、不进挑战页——这正是它能过瑞数的原因，切勿换成持久化注入。

## 关键经验（实测踩坑总结）

1. **零注入悖论**：对瑞数这类 VM 风控，**浏览器层的真实 > JS 层的伪装**。
   持久化 stealth 注入（`addScriptToEvaluateOnNewDocument`）会把
   `navigator.webdriver` 从原生值改成 getter，属性描述符变化被 VM 检测 →
   静默放弃出 cookie → 挑战后重载被 400 空响应。
2. **出口节点 IP 是最大环境变量**：同一引擎三个节点三个结果。IP 风控站
   （南师/南理工）会标记特定出口 IP；失败先重试、再换 Clash 节点。
   三组实测：Camoufox 在节点 A 上 3/5，节点 B/C 上 5/5。
3. **TLS 指纹层拦截**（兰大/川大对非 Chrome 指纹返回 400 空响应）：
   curl_cffi impersonate 与真实 Chrome/CDP 可过；CloakBrowser 这类 stealth
   Chromium 恒 2/5，换节点无效。
4. **Windows 提权会话坑**：Chrome 137+ 检测到提权会自我降权重启
   （父进程退出码 0 属正常）——启动检测只信调试端口；`--user-data-dir`
   必须是绝对路径（相对路径 Chrome 静默退出）。
5. **首访挑战偶发失败**：瑞数首访 412 挑战偶发未完成（约 1/10），
   失败重试即可（profile 已有 O-cookie 后第二次通常能成）。

## 选型指南

| 场景 | 推荐 |
|------|------|
| 默认 / 需要 IP 轮换 | ruyiPage（每tab代理） |
| 不想下载第三方内核 | CDP 零注入（系统 Chrome） |
| 服务器无浏览器环境 | sdenv 补环境 |
| 高风控 + 需要拟人交互 | ruyiPage（isTrusted 原生事件） |

多条路线互为容灾：任一方案失败时优先重试 → 换引擎 → 换出口节点。
