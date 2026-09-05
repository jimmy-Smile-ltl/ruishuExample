# site_i_customs — 海关信用系统 瑞数（站点I，iv8 路线 ✅ 已通）

> 匿名化说明：目标 URL 为 base64 编码，运行时自动解码；实名映射见仓库根 `sites_mapping.local.md`（本地维护，不入库）。

## 站点与挑战形态

| 项 | 值 |
|----|----|
| 目标 | 海关信用系统（`credit.customs.gov.cn`，http 明文协议） |
| WAF | 瑞数 6 代（412 + O/P 双 cookie，P 前缀 `act_`，与高校组同族） |
| 特殊点 | **http 页面 + cookie 带 `; Secure` 属性**（真 Chrome 在非 https 页忽略 Secure 照存） |

## 状态：✅ iv8 已通（2026-09-05，1.0s，2 轮）

本目录经历了「失败归档 → 翻盘成功」的完整过程，两层根因均在 iv8 路线上定位并修复，
是 iv8 路线**最有价值的一个站点**——它逼出了两个通用打法，已沉淀进 `iv8_kit/`。

```bash
pip install iv8 requests
python spider_iv8.py
# ✅ 200  13212b  中国海关企业进出口信用信息公示平台  (0.9s)
```

## 攻克史：两层根因

### 第一层根因：Secure 属性被 iv8 0.1.4 丢弃

- 海关站是 `http://` 明文协议，但服务器下发的 O cookie 和 VM 生成的 P cookie 都带
  `; Secure` 属性。真 Chrome 在非 https 页面上会**忽略 Secure 属性照样存储**
  （RFC 6265bis §5.3），而 iv8 0.1.4 的 cookie 存储把整个 cookie 丢弃
  → `document.cookie` 为空 → 回放 412。
- 修复（已内置 `iv8_kit/`，http 站自动生效）：
  1. `hook_strip_secure.js` 包装 `Document.prototype.cookie` setter 剥离 Secure
  2. 传入 `page.load` 的 Set-Cookie 响应头同样剥离（且用 `headers.items()`
     会丢失重复 Set-Cookie 头，需 getlist 语义逐头处理）
  3. cookie 直接读完整 jar（netLog 的 cookieHeader 可能只含 O，P 是 meta refresh 后写入）

### 第二层根因：多轮挑战复用 JSContext 状态污染

- 修复第一层后 O+P 都能成形，但回放仍 412；多轮循环里第 2 轮起 VM 不再写 P。
- 真根因：**复用同一个 JSContext 时，`window.$_ts` 等上一轮挑战的残留状态会污染
  后续轮 VM 的执行路径**（nodenv 方案每轮全新 node 进程，天然规避了这个问题）。
- 修复：每轮挑战用**全新 JSContext**（`iv8_kit.chain_get` 已内置）。

### 排查陷阱备忘（对 iv8 深度排查极有价值）

- iv8 对齐 Chromium 把事件监听器/timer 回调异常**吞掉不抛回 JS**——自己写的
  诊断 hook 抛错会静默丢失 cookie 写入，误判为「VM 没写 cookie」。
- `page.load` 会换新 window，但 `Document.prototype` 跨 load 存活（hook 位置要选对）。
- Python 三引号字符串里写 JS 正则 `\b` 会被转义成退格符——hook 放独立 .js 文件最稳。

## 对比结论（iv8 路线的适用边界，已随全库打通更新）

| 站点 | iv8 结果 |
|------|---------|
| 药监局（6 代 debugger 变体） | ✅ 200（0.65s，`site_d_debugger/spider_iv8.py`） |
| 重庆/天津税务（6 代） | ✅ 一次通过（`tax_ruishu/spider_iv8_cq.py` / `spider_iv8_tj.py`） |
| 欧冶（6 代） | ✅ 一次通过（iv8 上游 examples） |
| 高校组/国网/医院/信通院/专利/维普 | ✅ 全通（2026-09-05，各站 `spider_iv8*.py`） |
| **海关（6 代 http 变体）** | ✅ 已通（本目录，1.0s） |

**结论**：iv8 对全库瑞数变体（412/202、http/https、debugger/加强/TLS 双变体）
全部可用，速度 0.6-4.3s/站（nodenv 13-14s、sdenv 7-20s 的 1/10），
零 npm 依赖、免算法逆向。多路线互为容灾的格局中，iv8 已成为「无浏览器部署」档的
**首选路线**——致谢见仓库根 README「iv8 运行时路线」章节。
