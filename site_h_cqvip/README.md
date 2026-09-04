# site_h_cqvip — 维普期刊 (CQVIP) 瑞数6 三路线：补环境双路线 + 纯算法（站点H，2026-09-05 实测 200）

> 教程来源：牛客网 discuss【爬虫JS逆向实战】某中文期刊服务平台瑞数6代cookie逆向（866318313683443712）。
> 匿名化说明：目标 URL 明文映射见仓库根 `sites_mapping.local.md`（本地维护，不入库）。
> 🔒 **开源策略**：路线 C 纯算法（`pure_algo/` 内代码）**不开源**，密码体系破译成果见
> [pure_algo/README.md](pure_algo/README.md)（完整技术记录）；路线 A/B 补环境正常开源。

## 站点与挑战形态

| 项 | 值 |
|----|----|
| 目标 | 期刊导航 JournalGuid 页（qikan 期刊服务平台） |
| WAF | 瑞数 6 代 classic 形态：`$_ts.nsd` + 内联 `cd` + `r='m'` meta + 外链 VM js |
| 412 页 | ~2.9KB + VM js 动态路径 |
| cookie | O-cookie（Set-Cookie 下发，HttpOnly，名每轮随机如 `6HZbKHDjIEcgS`）+ P-cookie（VM 本地生成，`6HZbKHDjIEcgT`，250-314c），同轮组合回放 |
| 形态判断 | 与 patent_cnipa（站点G）同族 → nodenv/sdenv 模板改 URL 即过，**零适配** |

## 成功路线（3/3 实测 200）

| # | 路线 | 依赖 | 速度/轮 | P-cookie |
|---|------|------|---------|----------|
| A | **sdenv 链式**（jsdom 补环境） | npm sdenv + curl_cffi | ~7-11.5s ⚡ | 314c @3.8s |
| B | **nodenv 零依赖手写补环境** | 纯 Node 内置 + curl_cffi | ~14s | 250c @12.2s |
| C | **纯算法 v11**（realDf 加密链 + nodenv 取钥） | 纯 Node + curl_cffi | ~18s | 236c 3/3 稳定 |

> 纯算法已攻克（2026-09-05 v11）：密码体系全破译 + 回放 200，见下方路线 C（`pure_algo/`）。
> 攻坚全程归档于 pro42 项目 `PURE_ALGO_NOTES.md`（v1-v23）。

## 快速启动

```bash
cd site_h_cqvip/

# A. sdenv 链式（sdenv 已在任意上层 node_modules，或设 SDENV_DIR）
py -3.12 spider_sdenv.py --rounds=3

# B. nodenv 零依赖（node 侧零依赖，node ≥ 18）
py -3.12 spider_nodenv.py --rounds=3

# C. 纯算法 v11 🔒 代码不开源——技术记录见 pure_algo/README.md
#    (realDf 加密链 + nodenv --capture-inner 取钥; 已实锤 5/5 轮 200, ~18s)
```

## 避坑

1. 外链 VM JS 对 curl_cffi 一律 412（TLS 指纹分发），但 nodenv 的 Node fetch 可直接拿到——
   **VM 下载必须走 Node 侧**（run_vm.js 已内置 fetch 下载，勿用 Python 预下载）。
2. 教程「cookie 长度对齐」→ 本站 P-cookie 250c（nodenv）/ 314c（sdenv）均为合法长度，
   回放 200 是唯一判据（勿以长度对齐为锚点，见全局规则 ruishu-env-patch.md）。

## 文件

```
site_h_cqvip/
├── spider_sdenv.py       # sdenv 链式 (SDENV_DIR 向上递归查找)
├── spider_nodenv.py      # nodenv 链式
├── generate_cookie.js    # sdenv jsdomFromText 本地执行
└── nodenv/               # 手写 vm 沙箱九件套 (patent_cnipa 移植)
    ├── run_vm.js         # 主入口: vm.createContext(DONT_CONTEXTIFY) + 挑战页执行 + cookie 轮询
    ├── env.js            # 手写浏览器环境
    ├── trace_hooks.js    # 插桩器 (仅 --trace-task 诊断)
    ├── align_order.js / align_window.js / align_document.js  # 键集对齐
    └── jsdom_texts.json / xhr_proto.json / xhr_open_src.txt  # toString 指纹对齐
```
