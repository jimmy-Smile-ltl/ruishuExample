# 站点B（招聘平台）— 瑞数纯算法还原（rs-reverse）示例

目标站：`aHR0cHM6Ly96aGFvcGluLnNnY2MuY29tLmNuLw==`（base64，解码见文末）

防护：**瑞数**（412 挑战 + 双 Cookie + JSVMP 双层 VM）

> 🔒 **开源策略**：本目录为纯算法路线，**可运行代码（`spider.py` / `patch_rs_reverse.py`）
> 不开源**（防被直接用于大规模未授权采集），本文档为完整技术记录。
> 想直接跑通瑞数站点请使用仓库内开源的补环境/浏览器路线（sdenv / nodenv / CDP / ruyiPage）。

> 匿名化说明：站名使用代号（站点B），目标 URL 为 base64 编码。
> 解码：`echo <b64> | base64 -d`（bash）/ `[Convert]::FromBase64String("<b64>")`（PowerShell）。

**本方案是纯算法路线：无需浏览器、无需补环境，直接还原瑞数加密算法计算 P cookie，
实测 2026-08 通过 200 验证。**

## 挑战流程

```
① GET 目标页 (无 cookie)
     ← 412 + Set-Cookie: <15字符名>S (O cookie) + [$_ts.nsd/cd] + [VM 解释器 JS]
② rs-reverse 还原 VM 字节码 → 按站点适配器(basearr)重建内层数据
   → Feistel-CBC 加密 + 自定义 base64 → 计算 <15字符名>T (P cookie)
③ GET 目标页 (带 O+P cookie) → 200 ✅
```

## 原理

[pysunday/rs-reverse](https://github.com/pysunday/rs-reverse)（v1.16.3）完整逆向瑞数
加密体系：

```
cookie = '0' + b64(Feistel-CBC([uuid(4)+nextarr], keys[16]+time))
uuid   = CRC32(nextarr)                      # 解密正确性校验
nextarr = [时间戳, keys2, hasDebug, basearrEncrypt]
basearr = 站点适配器模板                      # ★ 关键: 每站不同
```

- 外层 Feistel-CBC 通用；**内层 basearr 是站点相关的**——这就是"适配器"机制
  （`src/handler/basearr/` 按长度分类：len103/123/127/133/157/163/166）
- 站点B 命中 len127 适配器（作者适配过，模板含该站域名）→ 直接可用
- **未适配站点**（如某高校站）：长度匹配但模板内容不匹配 → cookie 被 412 拒。
  支持新站 = 逆向该站真实 basearr 后新增适配器

## 用法

> 🔒 代码未开源，以下命令仅为已获代码者记录调用链：

```bash
# 1. 安装依赖（在本目录执行）
npm install rs-reverse

# 2. 打 2 个 Windows 兼容补丁（sdenv-extract 路径 bug + gv._ts getter）
# python patch_rs_reverse.py

# 3. 跑爬虫（生成 cookie → 验证 200 → 保存页面）
# python spider.py
```

成功输出：`site_b_200.html`（200 页面）+ 控制台打印 P cookie 长度。

## 关键文件

| 文件 | 说明 |
|------|------|
| `spider.py` | 🔒 curl_cffi 调度：412 → node makecookie → 带 O+P 验证 200（**不开源**） |
| `patch_rs_reverse.py` | 🔒 安装后自动打 2 个 bug 补丁（**不开源**） |
| `README.md` | 本文件（技术记录，开源） |

## 依赖与坑

```bash
pip install curl_cffi
npm install rs-reverse    # 注意: 本目录不能在 npm workspace 树内(否则 npm install 被根路由)
```

**两个必打补丁**（v1.16.3 上游缺陷，`patch_rs_reverse.py` 一键处理）：

1. `sdenv-extract@0.1.8` 的 `utils/paths.js`：`split(/[\/]/)` 不匹配 Windows 反斜杠
   → 任何依赖 sdenv-extract 的工具在 Windows 必崩（`path.resolve` 收到 false）
2. `rs-reverse` 的 `src/handler/globalVarible.js`：缺 `get _ts()` getter
   → `makecode-high`（额外 debugger 版本站点）路径必崩

## 实测记录（2026-08）

| 站点 | 适配 | 结果 |
|------|------|------|
| 站点B | ✅ len127（作者适配） | **200，31.5KB**，cookie 生成 1.06s |
| 某高校站 | ❌ 仅长度匹配，模板是站点B 的 | 412 拒收 |

对比同期的补环境/浏览器路线（sdenv 5/5、ruyiPage 5/5）：
**适配过的站点 rs-reverse 最快最轻**（纯算法、无浏览器、秒级、curl_cffi 复用）。

## iv8 运行时路线（2026-09-05 新增 ✅ 200, 1.0s）

```bash
pip install iv8 requests
python spider_iv8.py      # 412 → iv8 VM → 200
```

- iv8 = Python 原生 V8 + C++ 层浏览器环境（社区版非商用许可，
  github.com/HanZzzzz000/iv8），瑞数 VM 直接执行出 cookie
- 与 rs-reverse 纯算法同速（1.0s vs 1.1s），但**免算法逆向、免 basearr 适配表维护**
  ——版本轮换对 iv8 透明（跑的就是线上最新 JS）
- 共享工具链在仓库根 `iv8_kit/`；所有 iv8 路线站点用法一致：改 URL 即用

## 注意事项

- 瑞数 cookie 名每站随机（`<随机名>S/T` 等），脚本从响应动态解析，勿硬编码
- 站点若升级 VM 结构需重新适配（项目 2026-02 起停更，适配自己维护）
- 每轮 412 的 nsd/cd 随机，O cookie 必须与 P 同轮配对使用
