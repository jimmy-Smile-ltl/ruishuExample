# site_i_customs — 海关信用系统 瑞数（站点I，iv8 路线失败归档）

> 匿名化说明：目标 URL 为 base64 编码，运行时自动解码；实名映射见仓库根 `sites_mapping.local.md`（本地维护，不入库）。

## 站点与挑战形态

| 项 | 值 |
|----|----|
| 目标 | 海关信用系统（`credit.customs.gov.cn`，http 明文协议） |
| WAF | 瑞数（412 + O/P 双 cookie，P 前缀 `act_`，与高校组同族） |
| 特殊点 | **http 页面 + cookie 带 `; Secure` 属性**（真 Chrome 在非 https 页忽略 Secure 照存） |

## 状态：❌ iv8 未通（两层根因，2026-09-05 定位）

同批验证中 **税务 / 药监 / 欧冶三个瑞数站 iv8 一次通过**，海关是 iv8 目前已知的边界样本。
本目录保留诊断脚本与两层根因，作失败归档（与 patent_cnipa/handpatch 同性质）。

### 第一层根因（已修复）：Secure 属性被 iv8 0.1.4 丢弃

- 海关站是 `http://` 明文协议，但服务器下发的 O cookie 和 VM 生成的 P cookie 都带
  `; Secure` 属性。真 Chrome 在非 https 页面上会**忽略 Secure 属性照样存储**
  （RFC 6265bis §5.3），而 iv8 0.1.4 的 cookie 存储把整个 cookie 丢弃
  → `document.cookie` 为空 → 回放 412。
- 修复三件套（已内置 `spider_iv8.py`）：
  1. `hook_strip_secure.js` 包装 `Document.prototype.cookie` setter 剥离 Secure
  2. 传入 `page.load` 的 Set-Cookie 响应头同样剥离（且用 `raw.headers.items()`
     会丢失重复 Set-Cookie 头，需改用 getlist 语义逐头处理）
  3. cookie 直接读完整 jar（netLog 的 cookieHeader 可能只含 O，P 是 meta refresh 后写入）

### 第二层根因（未修复）：P 密码学内容无效

- P cookie 成形（343 字符，`act_` 前缀，与高校组同族）后服务器仍 412 拒收并每轮下发新 O
  → P 的密码学内容无效，属于该站瑞数 VM 变体的**深层环境对齐问题**
  （同高校组"8 处环境差异"类问题）。
- 对齐方向：参照 nodenv 的键集/形态对齐方法论（`patent_cnipa/nodenv/`），
  但 iv8 环境为 C++ 层实现，无法像手写环境那样逐键对齐——需等待 iv8 上游
  对该变体的支持或改用补环境/浏览器路线。

## 对比结论（iv8 路线的适用边界）

| 站点 | iv8 结果 |
|------|---------|
| 药监局（6 代 debugger 变体） | ✅ 200（0.65s 出 cookie，`site_d_debugger/spider_iv8.py`） |
| 重庆税务（6 代） | ✅ 一次通过（`tax_ruishu/spider_iv8_cq.py`） |
| 欧冶（6 代） | ✅ 一次通过（见 iv8 上游 examples） |
| **海关（6 代 http 变体）** | ❌ 第一层已修、第二层 P 无效（本目录） |

**结论**：iv8 对多数瑞数变体可用且极快（0.65s），但 http 明文站 + 特定 VM 变体
存在环境对齐缺口——**任何单一路线都有边界，多路线互为容灾**（见根 README 选型流程）。

## 用法（诊断复现）

```bash
pip install iv8 requests
python spider_iv8.py    # 预期输出: P 343c 成形 → 回放 412 (第二层根因)
```

## 文件

| 文件 | 说明 |
|------|------|
| `spider_iv8.py` | iv8 链式诊断脚本（两轮 page.load + XHR hook 捕获） |
| `hook_strip_secure.js` | 第一层根因修复 hook（剥 Secure） |
| `README.md` | 本文件 |

## 依赖许可提示

iv8 为第三方**社区版**（Community Edition License，仅限个人/教育/非商业使用，
禁止再分发软件本体）。本目录仅收录用法示例脚本，iv8 本体请自行 `pip install iv8`。
