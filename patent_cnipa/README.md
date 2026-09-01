# patent_cnipa — 专利局瑞数 WAF 站点族（检索 + 公布公告，同族多路线一项目）

CNIPA 专利局两个站点共享同族瑞数 WAF（`$_ts.nsd/cd` + O/P 双 cookie + VM 挑战页），
合为一个项目。**可行路线 3 条实测 200 ✅；已证不可行路线 2 条归档为教训。**

> 匿名化说明：目标 URL 为 base64 编码，运行时自动解码；实名映射见仓库根 `sites_mapping.local.md`（本地维护，不入库）。

## 目录

- [站点与挑战形态](#站点与挑战形态)
- [技术路线全景](#技术路线全景)
- [快速启动](#快速启动)
- [路线详解](#路线详解)
  - [A. sdenv 链式（jsdom 补环境）](#a-sdenv-链式jsdom-补环境)
  - [B. nodenv 零依赖手写补环境](#b-nodenv-零依赖手写补环境)
  - [C. CDP RPC（浏览器原生过挑战）](#c-cdp-rpc浏览器原生过挑战)
  - [D. handpatch 手写补环境（❌ 失败归档）](#d-handpatch-手写补环境-失败归档)
  - [E. rs-reverse 纯算法（❌ 未打通）](#e-rs-reverse-纯算法未打通)
- [避坑](#避坑)
- [文件](#文件)
- [解码命令](#解码命令)

## 站点与挑战形态

| 子站 | 挑战形态 | 挑战页 | 数据可爬性 |
|------|---------|--------|-----------|
| 检索站 `...conventionalSearch` | 412 + O/P 双 cookie | ~2.5KB 小页面 + VM 动态路径（~304KB） | ❌ 检索结果页需 CNIPA 统一身份认证登录（无账号） |
| 公布公告站 `aHR0cDovL2VwdWIuY25pcGEuZ292LmNu`（base64） | **202** 变体 + O/P 双 cookie | 同族，形态略异 | ✅ 免登录，专利公告全量可爬（生产已落地） |

**WAF 特征**：瑞数 6 代。O-cookie 由挑战响应 Set-Cookie 下发；P-cookie 由 VM 在本地环境
执行生成（`document.cookie` 读取，含 enable 标志自动删除）。cookie 名**每轮随机**
（如 `dX1xbeyMT58WO`/`dX1xbeyMT58WP`），不要硬编码。

## 技术路线全景

| # | 路线 | 依赖 | 速度/轮 | 检索站 | 公布公告站 | 备注 |
|---|------|------|---------|--------|-----------|------|
| A | **sdenv 链式**（jsdom 补环境） | npm sdenv + curl_cffi | 9.9-20s | ✅ 200 | ✅ 200 | 最早打通，参照系 |
| B | **nodenv 零依赖手写补环境** | 纯 Node 内置 + curl_cffi | 13.2-13.8s | ✅ 200（9/9） | 未测 | 2026-09-01 打通，无需 sdenv |
| C | **CDP RPC**（浏览器原生过挑战） | Chrome + websocket-client | ~3s/页 | ✅ 可过挑战 | ✅ **生产爬虫** | 翻页需页面内 token |
| D | handpatch 手写补环境 | 纯 Node | — | ❌ 400 | — | 2026-08-15 早期尝试，233c 恒 400 |
| E | rs-reverse 纯算法 | npm rs-reverse | — | ❌ 未打通 | ❌ | codemap op 语义错位（pro38 归档） |

**选型结论**：
- 要**零 npm 依赖**且能接受 ~13s → **B nodenv**（`python spider_nodenv.py`）
- 要**最快纯 HTTP** → A sdenv（`python spider_sdenv.py`，jsdom 执行更快）
- 要**生产爬数据**（公布公告站）→ C CDP RPC（页面内 token 免逆向，断点续爬）
- D/E 是逆向研究的教训沉淀，不可投产

## 快速启动

```bash
# 依赖
pip install curl_cffi               # A/B/C 通用；C 另需 websocket-client psutil
npm install                         # 仅 A 需要（sdenv）；B 零 npm 依赖

# 检索站 — A: sdenv 链式 (412 → VM → 200)
python spider_sdenv.py

# 检索站 — B: nodenv 零依赖手写补环境链式 (412 → VM → 200, 无需 npm install)
python spider_nodenv.py

# 公布公告站 — A: sdenv 链式 (202 → VM → 200) / C: RPC 生产爬虫
cd epub
python spider_sdenv.py
python rpc_spider.py 石墨烯 --max-pages 100
```

> 环境提示 (2026-08-31): 本机 anaconda3 已卸载（`python` 命令指向残留 exe，运行即报
> `ModuleNotFoundError: No module named 'encodings'`）。请用 `py -3.12` 或你本机
> 对应版本的 python.exe 运行。

无本地 node_modules 时复用已有 sdenv 安装（Windows，路线 A）:
```powershell
$env:SDENV_DIR = "C:\...\spider research\node_modules"
python spider_sdenv.py
```

## 路线详解

### A. sdenv 链式（jsdom 补环境）

```
curl_cffi (impersonate=chrome110)          ← TLS 指纹与最终回放一致（空响应/400 的多发点）
  ├─ GET → 挑战页 (412/202) + Set-Cookie O-cookie
  ├─ node generate_cookie.js               ← jsdomFromText 本地执行挑战页
  │    ├─ resources:'usable' → jsdom 自动加载页面外链 VM 脚本
  │    ├─ timer 回调 try/catch 包裹        ← 缺失 API 不中断 cookie 链
  │    ├─ location.replace 阻断            ← 防跳转中断 VM cookie 生成
  │    └─ 轮询 document.cookie 稳定 → 输出 P-cookie
  └─ 组合 O+P cookie → 下一轮 → 200
```

- 首个打通本站的方案（2026-08-19 实测 9.9s；08-20 20.0s）。
- jsdom 提供真实 DOM 实现，是本族 WAF 补环境的最稳底线。

### B. nodenv 零依赖手写补环境

- **2026-09-01 打通，9/9 全 200（13.2-13.8s/轮）**。不用 sdenv，纯手写 Node vm 沙箱。
- 三阶段根因史：**400（8 处环境差异）→ 0c（env cookie setter 过期判断误删）→ 200（fixDateMs 对齐）**。完整记录见 `nodenv/README.md`。
- 核心教训：**env 宿主侧与 VM 沙箱侧的时间源必须一致**——VM `--fixdate` 只覆盖 ctx.Date，
  env 侧 cookie 逻辑仍走宿主 `Date.now()`，错位即产生"写成功却读空"的静默删除。
- 技术要点：`vm.createContext(DONT_CONTEXTIFY)` + window Proxy + fakePTS 三分支
  toString + window/document 键集对齐（`align_*.js`，sdenv 实测 248/217 键）。

### C. CDP RPC（浏览器原生过挑战）

- 公布公告站生产方案：`epub/rpc_spider.py`，持久 Chrome profile + 页面内 XHR 自动附加
  瑞数动态 token，翻页全通（~3s/页），支持断点续爬。
- **翻页必须走页面内**：`/Dxb/PageQuery` 需要页面 XHR hook 附加的 token，纯 curl 无 token → 400。
- 检索站也可过挑战（挑战通过后页面 Vue 正常挂载），但业务数据被登录墙挡。

### D. handpatch 手写补环境（❌ 失败归档）

- 2026-08-15 早期尝试：VM 正常跑、cookie 233c 成形，但服务端 400 拒收。
- 失败根因：缺 window/document 键集对齐（8 处）等环境细节 + codegen phase-2 未执行。
- 后被 nodenv（B 路线）以完整修复链取代。证据链与诊断方法论见 `handpatch/README.md`。

### E. rs-reverse 纯算法（❌ 未打通）

- rs-reverse（pysunday）对本站的 codemap op 语义错位（真实 VM op4=push 字面量 vs
  codemap op4=pop+store），trace 已反推 116 op 真实语义表，但脱离 trace 复现 offset
  的表映射未完成。深挖资产在 pro38 归档（`real_op_table.md` 等），不在本仓库。

## 避坑

| 现象 | 原因/对策 |
|------|-----------|
| VM 输出 0 chars | 等待秒数太短（默认 10s，实测 ~12s 建议 16s）；或 env setter 时间源错位误删 cookie（nodenv 已修） |
| P cookie 生成但回放 400 | HTTP UA 必须 == VM 内 navigator.userAgent（脚本已统一）；或 TLS 指纹不符 → 用 curl_cffi chrome110 |
| 200 页面拿到了，但检索接口报错 | 与 WAF 无关 — 检索站业务数据需登录；公布公告站免登录 |
| cookie 名对不上文档 | 每轮随机生成，用 session 自动管理即可 |
| 翻页偶发 400（RPC 爬虫） | 用「下页」按钮点击路径（勿直接调 to_page()）；只顺序翻页，跳页/改页大小会清游标 |
| nodenv 回放 400（旧版） | 8 处环境差异未修（08-19 版）— 使用当前 nodenv/ 已修版本 |

## 文件

```
patent_cnipa/                 # 站点族项目
├── spider_sdenv.py           # A 路线: sdenv 链式 (检索站, 200 实测 9.9-20s)
├── spider_nodenv.py          # B 路线: nodenv 零依赖补环境链式 (检索站, 200 实测 9/9)
├── generate_cookie.js        # A 路线 VM 执行器 (两站共用: jsdomFromText + 3 处注入)
├── nodenv/                   # B 路线: 零依赖手写补环境 (env.js/run_vm.js + 指纹对齐表)
├── epub/                     # 公布公告站 (202 变体, 免登录, 可全量爬)
│   ├── spider_sdenv.py       #   A 路线链式验证
│   └── rpc_spider.py         #   C 路线生产爬虫 (CDP RPC, 断点续爬)
├── handpatch/                # D 路线失败归档 (233c 恒 400, 教训 + 方法论)
├── package.json / .gitignore
└── output/                   # 运行时产物 (已 gitignore)
```

## 解码命令

```bash
echo <base64> | base64 -d          # bash
[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("<base64>"))   # PowerShell
python -c "import base64;print(base64.b64decode('<base64>').decode())"
```
