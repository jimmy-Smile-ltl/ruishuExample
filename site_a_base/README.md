# 站点A（高校组）— 大学高校瑞数 WAF 绕过方案集

来源：高校组瑞数实战（原 pro36），2026-08-13 整理，**2026-08-19 复测确认**。
5 所使用瑞数 WAF 的高校官网，5 条可行方案（全部实测 5/5），最小可验证代码。

> 匿名化说明：站名使用代号（高校1-5），官网 URL 为 base64 编码。
> 解码：`echo <b64> | base64 -d`（bash）/ `[Convert]::FromBase64String("<b64>")`（PowerShell）。

## 目标站点

| 高校 | 官网 (base64) | 风控特征 |
|------|--------------|---------|
| 高校1 (985) | `aHR0cHM6Ly93d3cubHp1LmVkdS5jbg==` | 极严格 TLS |
| 高校2 (985) | `aHR0cHM6Ly93d3cuc2N1LmVkdS5jbg==` | 极严格 TLS |
| 高校3 (211) | `aHR0cHM6Ly93d3cuYnVwdC5lZHUuY24=` | 宽松 |
| 高校4 (211) | `aHR0cHM6Ly93d3cubmpudS5lZHUuY24=` | 极严格 TLS + **IP 风控** |
| 高校5 (211) | `aHR0cHM6Ly93d3cubmp1c3QuZWR1LmNu` | 宽松 + IP 风控 |

## 方案矩阵（实测）

| 方案 | 文件 | 通过率 | 单页耗时 | 内核/协议 | 定位 |
|------|------|--------|---------|-----------|------|
| **ruyiPage** | `spider_ruyipage.py` | **5/5** | **2-3s** | Firefox / WebDriver BiDi | 🏆 首选（每tab独立代理） |
| **CDP 零注入** | `spider_cdp.py` | **5/5** | 5-6s | 真实 Chrome / CDP | Chrome 系首选（无第三方内核） |
| sdenv 补环境 | `spider_sdenv.py` + `generate_cookie.js` | 5/5 | 13-15s | 纯 Node + curl_cffi | 无浏览器部署 |
| Camoufox | `spider_camoufox.py` | 5/5* | 2-10s | Firefox / Playwright | 备胎 |
| DrissionPage | `spider_drission.py` | 5/5 | 2-128s | 系统 Chrome / CDP | 稳妥但慢 |

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
   （高校4/高校5）会标记特定出口 IP；失败先重试、再换 Clash 节点。
   三组实测：Camoufox 在节点 A 上 3/5，节点 B/C 上 5/5。
3. **TLS 指纹层拦截**（高校1/高校2 对非 Chrome 指纹返回 400 空响应）：
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
