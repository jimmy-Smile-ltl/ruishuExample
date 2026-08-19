# patent_cnipa — 专利检索系统 (CNIPA) 瑞数6 sdenv 链式方案（最简可行版）

**站点**: `aHR0cHM6Ly9wc3Mtc3lzdGVtLmNwb25saW5lLmNuaXBhLmdvdi5jbi9jb252ZW50aW9uYWxTZWFyY2g=`（base64，解码见文末）

> 匿名化说明：目标 URL 为 base64 编码，运行时自动解码；实名映射见仓库根 `sites_mapping.local.md`（本地维护，不入库）。

**结论**: sdenv 链式方案 ✅ **200 实测通过**（2026-08-19/20 两次验证：9.9s / 20.0s）。
手写 Node vm 补环境 ❌ 不可行（同形状 357 chars cookie 恒 400 — 差异在 VM 深栈运行时对象，补环境无法对齐；全链证据见 nodenv 归档，2026-08-19）。

## 快速启动

```bash
# 依赖
pip install curl_cffi
npm install              # 安装 sdenv（或设 SDENV_DIR 指向已有 node_modules）

# 运行（链式: 412 → VM 生成 P-cookie → 200）
python spider_sdenv.py
```

无本地 node_modules 时复用已有 sdenv 安装（Windows）:
```powershell
$env:SDENV_DIR = "C:\...\spider research\node_modules"
python spider_sdenv.py
```

## 方案原理（为什么这样设计）

```
curl_cffi (impersonate=chrome110)          ← TLS 指纹与最终回放一致（空响应/400 的多发点）
  ├─ GET /conventionalSearch → 412 挑战页 (2.5KB) + Set-Cookie O-cookie
  ├─ node generate_cookie.js               ← jsdomFromText 本地执行挑战页
  │    ├─ resources:'usable' → jsdom 自动加载页面外链 VM 脚本
  │    ├─ timer 回调 try/catch 包裹        ← 缺失 API 不中断 cookie 链
  │    ├─ location.replace 阻断            ← 防跳转中断 VM cookie 生成
  │    └─ 轮询 document.cookie 稳定 → 输出 P-cookie (357 chars, ~6-10s)
  └─ 组合 O+P cookie → 下一轮 → 200
```

- **O/P 双 cookie 缺一不可**：O 由 412 响应下发，P 由 VM 在本地环境生成（`enable_` 标志自动删除）。cookie 名每轮随机（本站本轮 O=`dX1xbeyMT58WO` P=`dX1xbeyMT58WP`）——**不要硬编码 cookie 名**。
- **为什么用 jsdom 而非手写环境**：本站瑞数为加强版，VM 检测深层 DOM 结构（事件收集器、运行时对象），手写补环境在 16-136 任务内 [o][43] 运行时对象处分叉（length 4 vs 2）→ trace 不可达的深栈差异 → cookie 400。jsdom 提供真实 DOM 实现，是此类站点补环境的底线。
- **为什么 3 轮上限**：首轮 412 拿 O，VM 出 P 后第二轮即 200（实测首轮即过）；最多 3 轮防 IP 限流（连续失败等 1-3 小时或换代理）。

## 避坑

| 现象 | 原因/对策 |
|------|-----------|
| VM 输出 0 chars | 等待秒数太短（默认 10s）；或 sdenv 版本过旧 |
| 200 页面拿到了，但检索接口报错 | 与 WAF 无关 — 本站业务数据需要 CNIPA 统一身份认证登录（SSO OAuth），需账号 |
| cookie 名对不上文档 | 每轮随机生成，用 session 自动管理即可 |
| P cookie 生成但回放 400 | HTTP UA 必须 == VM 内 navigator.userAgent（脚本已统一） |

## 文件

- `spider_sdenv.py` — 链式主脚本（curl_cffi 全部 HTTP）
- `generate_cookie.js` — VM 执行器（sdenv jsdomFromText + 3 处注入）
- `package.json` / `.gitignore`

## 解码命令

```bash
echo <base64> | base64 -d          # bash
[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("<base64>"))   # PowerShell
python -c "import base64;print(base64.b64decode('<base64>').decode())"
```
