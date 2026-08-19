# 瑞数 WAF 逆向方案集 — 总索引

按站点组织的逆向示例合集，覆盖 2025-2026 实战验证的全部可行路线。

## 站点案例

| 目录 | 站点 | 状态 | 可行方案 |
|------|------|------|---------|
| [site_e_enhanced](site_e_enhanced/)（站点E） | 中国信息通信研究院 | ✅ 活跃（2026-08-19 实测 200） | **jsdom 同步 flush**（421 chars 秒出）/ sdenv / CloakBrowser |
| [site_b_standard](site_b_standard/)（站点B） | 国家电网招聘网 | ✅ 活跃 | **rs-reverse 纯算法**（1.06s，200 验证） |
| [site_c_v67](site_c_v67/)（站点C） | 深圳大学总医院 | ✅ | sdenv / DrissionPage / CDP 零注入 / Camoufox |
| [site_a_base](site_a_base/)（站点A） | 5 所大学高校 | ✅ 2026-08-19 复测 | sdenv 13-15s / CDP 5-6s / ruyiPage 2-3s / Camoufox / DrissionPage |
| [site_d_debugger](site_d_debugger/)（站点D） | 药监局 | ✅ | sdenv 链式 / CDP |
| [tax_ruishu](tax_ruishu/)（站点F） | 税务局（TLS 指纹双变体版） | ✅ | **rs-reverse 纯算法 len173 自制适配器**（7/7 轮 200，~1s）/ 手写补环境 v3（5/5）/ **sdenv jsdom**（2/2，~17s） |
| [patent_cnipa](patent_cnipa/)（站点G） | 专利检索系统（CNIPA） | ✅ 2026-08-20 实测 200 | **sdenv 链式**（最简版，10-20s）；手写补环境 ❌ 恒 400（深栈分叉已归档） |

> 目录使用代号（site_A~G），真实站点映射见 `sites_mapping.local.md`（本地维护，不入库）。目标 URL 一律 base64 编码存储，运行时解码。

## 快速启动（税务局，三路线命令）

```bash
cd tax_ruishu/

# ★ sdenv 补环境（jsdom，2026-08-19 新通）：curl_cffi 抓 412 → node 生成 P cookie → 验证 200
pip install curl_cffi && python spider_sdenv_tj.py --rounds=3

# 手写补环境（零 npm 依赖）：同上链路，Node v3 模板
python spider_manual_env.py

# 纯算法（最快 ~1s/次）：npm install rs-reverse && python patch_rs_reverse_tj.py
python spider_rs_pure.py
```

## 三档方案决策表（核心知识）

| 档位 | 方案 | 依赖 | 速度 | 适用站点特征 | 已验证站点 |
|------|------|------|------|-------------|-----------|
| **1. 纯手写 VM** | rs6_crack.js（`--mode=full`） | **零依赖**（纯 Node 内置） | ~1.5s | 瑞数6基础版（无 eval 检测链/数组膨胀惩罚） | 甘肃发改（412→200 一次过） |
| **2. jsdom 补环境** | sdenv / jsdom_gen（同步 flush）/ round_gen（真实 timer）/ redirect-blocked | npm sdenv（Windows SDK 编译 canvas） | 2-14s（税务局 ~17s） | 瑞数6加强版（环境深层检测）——**环境是关键，timer 时序无关**（jsdom+同步flush 421 chars 实证） | 站点E / 高校1-5 / 深大总医院 / 药监局 / **税务局（2/2，escape 保留修复）** |
| **3. 浏览器** | CDP 零注入 / ruyiPage / CloakBrowser / RPC / DrissionPage / Camoufox | Chrome/Firefox | 1-18s | Cookie-TLS 强绑定 / IP 风控 / 极新 VM 形态 | 大学站 5/5（ruyiPage 2-3s/站最快）、深大总医院（CDP 3s） |
| **★ 纯算法** | rs-reverse（pysunday） | Node | ~1s | **basearr 适配器匹配的站点**（作者适配 + 自制适配器） | **国家电网招聘网（200 验证）、税务局（len173 自制适配器，7/7 轮 200）** |

## 选型决策流程

```
目标站 → 412 + $_ts 特征确认是瑞数
  ├─ rs-reverse basearr 适配表命中? → 档★ 纯算法（最快最轻, 无浏览器无补环境）
  ├─ 手写 VM 跑 rs6_crack.js 试一轮 → 通过? → 档1（零依赖生产首选）
  ├─ 触发了 VM 检测分叉 (Invalid array length)? → 档2 jsdom 补环境
  │    · 需要极致速度 → jsdom_gen 同步 flush（jsdom_hybrid 实验证实可行）
  │    · 同步 flush 崩（部分新 VM）→ round_gen 真实 timer（pro36 5/5 配方）
  └─ Cookie 被拒/绑定 TLS/极端检测 → 档3 浏览器（ruyiPage > CDP 零注入 > 其他）
```

## 关键认知（三项目实战沉淀）

### 环境 vs timer（站点E 决定性实验）

| 方案 | 环境 | timer | 结果 |
|------|------|-------|------|
| sdenv 原版 | jsdom | 真实(等8s) | 343 chars ✅ |
| 纯手写环境 | 手写 | 同步 flush | Invalid array length ❌ |
| jsdom_hybrid | jsdom | **同步 flush** | **421 chars ✅ 秒出** |

**环境是关键，timer 时序无关**——同步 flush 不破坏 VM 状态机，sdenv 类方案可提速 5-10 倍。

### 手写补环境的边界（pro2/pro8 教训）

- 基础版瑞数（甘肃类）：手写 600 行环境即可过
- 加强版（站点E/高校1-5/深大总医院类）：VM 检测深层结构（eval direct 语义 / 函数 realm / DOM 集合类型）——手写必然分叉，jsdom 是底线
- **浏览器层真实 > JS 层伪装**：对瑞数这类 VM 风控，真实 Chrome/Firefox 过挑战的可靠性远超补环境

### TLS 指纹双变体（税务局新发现，2026-08）

部分瑞数6站点按 **TLS 指纹（JA3）** 分发两套挑战 JS：浏览器（Chrome TLS）拿 174KB 友好版（1s 通关），Node/curl（OpenSSL TLS）拿 234KB 反机器版（`window['escape']` 门控死循环）。**变体与 UA 无关**（浏览器配 Firefox UA 仍拿友好版）。对策：纯算法路线不受变体影响（静态逆 VM 字节码 + 内层解密，见 tax_ruishu/）；补环境路线用 **curl_cffi（impersonate=chrome110）冒充 Chrome TLS 抓 412 拿友好版**，再喂手写 v3 模板执行（5/5 轮 200）或 **sdenv jsdom 执行**（2026-08-19 打通，2/2 轮 200，~17s/次；关键修复：**不能删 `window.escape`**——友好版 IIFE 的 opcode 178 分支依赖其 truthiness，反机器版时代的 `escape=undefined` 绕行残留会致 IIFE 早退无 P cookie，见 tax_ruishu/README.md 避坑 6）。2026-08-19 起服务器统一分发友好版（jj8pkMDMKUcA.43ade2a.js，无门控无自检），curl_cffi 抓到的即友好版。反机器版有两层 toString 自检：插桩即触发 `Invalid array length`（Node 侧）/空白页惩罚（浏览器侧）——只有透传钩子安全。

### 零注入原则（pro36 CDP 配方四要素）

1. 真实 chrome.exe + `--headless=new` + UA 对齐站点风控
2. **零 JS 注入**——任何 stealth 脚本改 navigator 属性描述符（值→getter）都会被 VM 检测
3. 导航用 renderer 跳转（`location.href=...`），不用 `Page.navigate`
4. Chrome 151+ 带 `--remote-allow-origins=*`，`--user-data-dir` 绝对路径

### 纯算法路线的现状（rs-reverse 深挖）

- 国家电网招聘网 ✅（适配器命中）；高校1 ❌（basearr 未适配 + tscd 对 2026 VM 失配）
- 内层密码系统已完全破解（真实内层 = AES 变体，非 Feistel 模型）
- 根本卡点：rs-reverse 的 codemap 提取/任务树解码与 2026 VM 的 opcode 语义存在差异（方法调用 opcode 的 `_$lJ()` 步骤丢失）
- 深挖资产：完整路线图与中间产物已归档（见 `site_d_debugger/纯算法攻克思路.md` 与 `tax_ruishu/README.md` 三节分析链路）

## 常见问题

- **站点返回空 404 + `wzws-ray` 头** → 多为 WAF 临时限流（491），等 30 分钟-数小时恢复（站点E 2026-08 误判为"换网神 WAF"，实测 08-19 仍瑞数 412 + 200）；持续数天再考虑换 WAF
- **P cookie 生成但 400/412** → 指纹一致性（HTTP UA == navigator.userAgent）；或 Cookie-TLS 绑定 → 档3
- **连续 3 轮失败** → IP 限流，等 1-3 小时或换代理
- **Clash 节点 IP 被标记**（高校4/高校5 偶发）→ 先切 Clash 节点

## License

[MIT](LICENSE) — 本仓库为逆向工程学习示例，仅供安全研究与教育用途。

⚠️ 免责声明：本仓库全部代码仅用于 WAF 机制学习与合规的数据采集研究，请遵守目标网站的服务条款与当地法律法规，勿用于任何未授权的自动化访问。
