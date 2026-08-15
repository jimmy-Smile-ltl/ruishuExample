# 瑞数 WAF 逆向 — 多版本 × 多路线开源示例集

> 5 组真实站点、6 类技术路线、20+ 个最小可行脚本。
> 每个脚本都精简到"能请求到数据"的最小形态：单文件入口、最少依赖、成功即保存 `*_200*.html`。
> 所有结论均带实测日期与通过率（2026-08），数据可复现。

瑞数（RiverSecurity）是国内常见的 JSVMP 型 WAF：首次访问返回 412 挑战页，
浏览器执行双层 VM 解释器完成环境检测并计算 P-cookie，服务端校验 O/P 双 cookie 放行。
不同站点部署的瑞数版本差异极大——本项目按"**版本特征**"组织站点，
按"**技术路线**"组织方案，交叉展示哪些路线在哪些版本上成立。

## 匿名化说明

公开仓库不出现真实站名与明文目标 URL：

- **站名**：使用代号（站点A-E、高校1-5），按瑞数版本特征命名目录；
- **目标 URL**：base64 编码存储，代码内运行时解码（可直接运行），文档中显示编码串；
- 真实站点与 URL 的对应关系维护在本地文件 `sites_mapping.local.md`（已 gitignore，不随仓库发布）。

解码：`echo <b64> | base64 -d`（bash）｜`[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("<b64>"))`（PowerShell）。

## 项目结构

```
ruishuExample/
├── site_a_base/         # 站点A：5 所高校（基础版），5 条浏览器/补环境路线
├── site_b_standard/     # 站点B：招聘平台（标准双层 VM），rs-reverse 纯算法 len127 现成适配
├── site_c_v67/          # 站点C：医院（v6/v7 双层编码），手写补环境 v3（20/20 轮）
├── site_d_debugger/     # 站点D：药品监管部门（debugger 变体 + 多阶段），5 方案全路线覆盖
│                        #        （含纯算法 len160 自制适配器）
└── site_e_enhanced/     # 站点E：研究院（加强检测版）（站点已换 WAF，保留作参考）
```

## 一、总览矩阵（核心）

图例：✅ 实测通过（附耗时/通过率）｜❌ 实测失败（原因已记录，见各目录"避坑"章节）｜`—` 本仓库未实施该组合

### 无浏览器路线

| 技术路线 | 核心技术 | 站点A<br>(基础版) | 站点B<br>(标准版) | 站点C<br>(v6/v7) | 站点D<br>(debugger 变体+多阶段) | 站点E<br>(加强检测版) |
|---|---|---|---|---|---|---|
| **rs-reverse 纯算法** | 还原 Feistel-CBC 外层 + 自制 basearr 站点适配器 | ❌ 高校1 实测 412 拒收（len127 模板不匹配） | ✅ 1.06s 出 cookie，200 31.5KB | `—` | ✅ len160 适配器 + v7 提升器，~75% 轮次，1-4s/轮 | ❌ VM 字节码 + 雪崩效应，需完整重写引擎 |
| **手写补环境** | 手工 mock window/document + setFuncNative 原生伪装层 | `—` | `—` | ✅ **v3 20/20 轮**，~3s | ✅ v3 10/10 轮（需同轮多跑 + 双复验） | ❌ 加强检测链 → 字节码流错位 → `Invalid array length` |
| **sdenv jsdom 补环境** | jsdom 完整 DOM + sdenv 原生 canvas/WebGL 模块 | ✅ 5/5，4-8s | `—` | ✅ ~14s（等真实 timer） | ✅ 链式续轮，~4s/页 | ✅ 343 chars；同步 flush 版 421 chars 秒出 |
| **手写 harness + browser() 直调** | JSDOM + sdenv 补丁层直调（脱离 jsdomFromText 流程） | `—` | `—` | `—` | ✅ 5-8s/页，三页全 200 | `—` |

### 浏览器路线

| 技术路线 | 内核 / 协议 | 站点A<br>(基础版) | 站点B<br>(标准版) | 站点C<br>(v6/v7) | 站点D<br>(debugger 变体+多阶段) | 站点E<br>(加强检测版) |
|---|---|---|---|---|---|---|
| **CDP 零注入** | 真实 Chrome / CDP，零注入配方四要素 | ✅ 5/5，1-5s | `—` | ✅ ~3s | ✅ 2-5s | `—` |
| **ruyiPage** | Firefox / BiDi，每 tab 独立代理 | ✅ **5/5，2-3s（首选）** | `—` | `—` | `—` | `—` |
| **Camoufox** | 反检测 Firefox | ✅ 5/5\*（IP 敏感，换节点恢复） | `—` | ✅ ~18s | `—` | `—` |
| **DrissionPage** | 系统 Chrome / CDP | ✅ 5/5，2-128s | `—` | ✅ ~4s | `—` | `—` |
| **CloakBrowser** | stealth Chromium（C++ 补丁） | ❌ 恒 2/5（TLS 指纹层拦截） | `—` | ❌ 挑战后重载 400（被 VM 指纹检测） | `—` | ✅ ~83%（15 次重试内） |

## 二、瑞数版本特征（为什么"版本"是核心变量）

| 站点组 | 目录 | 版本特征 | 特有难点 |
|---|---|---|---|
| 站点A：5 所高校 | `site_a_base/` | 基础版，单轮 412 | 站点间差异大：TLS 指纹（高校1/2 极严格）、IP 风控（高校4/5） |
| 站点B：招聘平台 | `site_b_standard/` | 标准双层 VM | 无——rs-reverse len127 现成适配器，纯算法开箱即用 |
| 站点C：医院 | `site_c_v67/` | v6/v7，JSVMP 双层编码 | timer 驱动阶段必须异步（同步 flush 导致 basearr 少 30 字节被 412 拒）；手写环境需伪装 ~45 个函数 |
| 站点D：药品监管部门 | `site_d_debugger/` | debugger 变体（hasDebug，hd 位 0x80）+ 多阶段（数据查询模块两轮 412） | 触发函数名每轮轮换；VM 变体轮换（约 2/3 轮任务执行崩）；纯算法需自制 len160 适配器 |
| 站点E：研究院 | `site_e_enhanced/` | 加强环境检测版 | eval direct 语义 / debugger / collection.item / 数组膨胀惩罚；手写补环境天花板，必须 jsdom 级环境；⚠️ 站点已于 2026-08 换网神 WAF，目录保留作逆向参考 |

**版本差异决定路线成败**的最典型例子：同为"timer 时序"问题，
站点E 加强版证明了"环境是关键，同步 flush 可行且 cookie 更长"；
站点C v6/v7 却证明"timer 驱动阶段必须异步，同步 flush 必被 412 拒"。
没有任何单一配方通吃所有版本。

## 三、技术路线详解

### A. rs-reverse 纯算法（零浏览器、零环境模拟）★ 最快最轻

外层 Feistel-CBC 加密通用，**内层 basearr 每站不同**——框架用"适配器"机制
（按加密后长度分类 len103/123/127/133/157/163/166）。适配过的站点秒级出 cookie、
curl_cffi 直接复用，是全仓库最快最轻的路线；未适配站点需要完整逆向该站真实 basearr。

| 站点 | 关键文件 | 适配情况 |
|---|---|---|
| 站点B（len127） | `site_b_standard/spider.py` + `patch_rs_reverse.py` | 作者已适配，开箱即用 |
| 站点D（len160） | `site_d_debugger/spider_rs_pure.py` + `patch_rs_reverse_site_d.py` + `纯算法攻克思路.md` | 自制 len160 适配器 + 6 项补丁（v7 函数声明预提升器，成功率 ~1/3 → ~75%） |

### B. 手写补环境（纯 Node 零 npm 依赖）

在 Node 里手工搭建"够用"的假 window/document 环境，让 VM 完整跑完。
适用于基础版瑞数；v6/v7 需要补上 **setFuncNative 原生伪装层**
（VM 逐个函数 toString 检测）与 VM 执行期隐藏 process/global。

- 站点C：`site_c_v67/spider_manual_env.py` + `env/browser_envs.js`（v3，20/20 轮）＋ 生产版 `spider_manual_prod.py`（27/27 文章，412 自动恢复）
- 站点D：`site_d_debugger/spider_env_v3.py` + `build_env.js` + `native_patch.js`（服务器校验窗口窄，需同轮多跑 + 双复验）
- 详解：`site_c_v67/方案5_手动补环境详解.md`

### C. sdenv jsdom 补环境（jsdom 级完整环境，无浏览器）

sdenv 提供 jsdom 完整 DOM + 原生 canvas/WebGL 模块，环境质量接近真实浏览器，
能过加强检测版（手写补环境的天花板）。代价是 npm 安装需编译原生模块。

- 站点A：`site_a_base/spider_sdenv.py` + `generate_cookie.js`
- 站点C：`site_c_v67/spider_sdenv.py`
- 站点D：`site_d_debugger/spider_sdenv_chain.py` + `stage_vm.js`（链式续轮应对多阶段挑战）
- 站点E：`site_e_enhanced/spider_sdenv.py`；提速版 `spider_jsdom_sync.py` + `jsdom_gen.js`（同步 flush，8s → ~2s，cookie 更长）

### D. 混合：手写 harness + sdenv 补丁直调

用 JSDOM 装载页面但脱离 sdenv 的 jsdomFromText 流程，
通过 `browser(w, 'chrome')` + `getHandle('window')({})` 直调补丁层（代理 realm）。
站点D 专属方案：`site_d_debugger/spider_handpatch.py` + `build_env_browser.js`。

### E. CDP 零注入（真实 Chrome，最快最稳的浏览器路线）

命令行启动真实 chrome.exe 后通过 CDP 接管，**配方四要素**（缺一不可）：

1. 真实 chrome.exe + `--headless=new` + `--user-agent=Chrome/138`
2. **零 JS 注入**——任何 stealth 注入都会把 navigator 属性从值改成 getter，描述符变化被 VM 检测后静默放弃出 cookie
3. 导航用 renderer 跳转 `Runtime.evaluate("location.href=...")`，不用 `Page.navigate`
4. Chrome 151+ 必须带 `--remote-allow-origins=*`；`--user-data-dir` 必须绝对路径

多阶段挑战在真实浏览器里自然完成，无需干预：`site_a_base/spider_cdp.py`、`site_c_v67/spider_cdp.py`、`site_d_debugger/spider_cdp.py`。

### F. 反检测浏览器框架

| 引擎 | 定位 | 关键文件 |
|---|---|---|
| ruyiPage | Firefox + BiDi，isTrusted 原生事件，**每 tab 独立代理**（直接解决 IP 风控） | `site_a_base/spider_ruyipage.py` |
| Camoufox | 反检测 Firefox，引擎级指纹伪装 | `site_a_base/spider_camoufox.py`、`site_c_v67/spider_camoufox.py` |
| DrissionPage | 系统 Chrome，最简单 | `site_a_base/spider_drission.py`、`site_c_v67/spider_drission.py` |
| CloakBrowser | stealth Chromium（C++ 补丁） | `site_e_enhanced/spider_cloakbrowser.py`（对加强版可用，但 v6/v7 与 TLS 严格站会被指纹检测识破） |

## 四、快速开始

```bash
# 纯算法（无浏览器，最快）—— 站点B（len127 现成适配）
cd site_b_standard
pip install curl_cffi && npm install rs-reverse
python patch_rs_reverse.py && python spider.py

# 纯算法 —— 站点D（len160 自制适配器 + 补丁）
cd site_d_debugger
pip install curl_cffi && npm install rs-reverse
python patch_rs_reverse_site_d.py && python spider_rs_pure.py

# 手写补环境（零 npm 依赖）—— 站点C
cd site_c_v67
pip install curl_cffi && python spider_manual_env.py

# sdenv jsdom 补环境（Windows 需 VS C++ 编译环境）—— 站点D 链式 / 站点E 提速版
cd site_d_debugger && npm install sdenv && python spider_sdenv_chain.py
cd site_e_enhanced && npm install sdenv && python spider_jsdom_sync.py

# 浏览器路线（需系统 Chrome）
cd site_a_base && python spider_cdp.py            # CDP 零注入
pip install ruyiPage && python -m ruyipage install && python spider_ruyipage.py   # 首选（站点A）
```

各目录内 README 含完整依赖说明与运行参数（如 `--url`、`--proxy`、`--headless`）。
脚本内的目标 URL 已 base64 编码并在运行时自动解码，无需修改即可运行（前提是目标站点仍是瑞数）。

## 五、选型指南

| 场景 | 推荐 |
|---|---|
| 站点已被 rs-reverse 适配（len127/160 等） | **纯算法**（A）——秒级、无浏览器、最轻 |
| 服务器无浏览器 + 站点未适配 | sdenv 补环境（C）→ 手写补环境（B，基础版/可补版本） |
| 有 Chrome 环境 | CDP 零注入（E）——最稳 |
| 需要 IP 轮换 / 拟人交互 | ruyiPage（每 tab 代理） |
| 容灾 | 多路线互为备份：失败重试 → 换引擎 → 换出口节点 |

## 六、通用经验（跨站踩坑总结）

1. **零注入悖论**：对瑞数这类 VM 风控，浏览器层的真实 > JS 层的伪装。持久化 stealth 注入改 navigator 属性描述符，VM 静默放弃出 cookie。
2. **TLS 指纹绑定**：cookie 与 TLS 指纹绑定。无浏览器路线一律 curl_cffi `impersonate="chrome110"`；Node 原生 TLS 直连会被 ECONNRESET。
3. **O/P 同轮配对**：每轮 412 的 nsd/cd 随机，O-cookie 必须与同轮计算的 P-cookie 配对使用；cookie 名每站甚至每轮随机，从响应动态解析，勿硬编码。
4. **出口 IP 是最大环境变量**：同一引擎在不同出口节点结果不同；IP 风控站会标记特定 IP。
5. **timer 时序结论因版本而异**（见第二章示例）：先确认目标瑞数版本再套用经验。
6. **手写补环境的天花板**：基础版可过，加强版必须 jsdom 级环境；判定标准是"服务端校验通过"，不是"P-cookie 能生成"。
7. **用前先确认站点仍是瑞数**：412 + `$_ts` 特征；空 404 + `wzws-ray` 响应头 = 已换网神 WAF。
8. **触发函数报错 = 正常**：挑战脚本后半段是页面跳转逻辑，找不到 DOM 节点就崩，此时 P-cookie 已生成，判断成功只看 cookie jar 与服务端响应。

## 七、开源说明

- **用途**：仅供网络安全学习与研究（逆向工程、WAF 原理、协议还原），请勿用于任何非法用途；使用本项目代码时请遵守目标网站服务条款与当地法律法规，并控制请求频率。
- **快照性质**：所有结论均带实测日期（2026-08）。瑞数会持续升级（VM 变体轮换、多阶段挑战、环境检测加强），站点也可能更换 WAF（如站点E 已换网神）——脚本失效时按各目录 README 的"避坑"章节排查。
- **仓库约定**：只含代码与文档；挑战页、VM 提取物、cookie 等运行时产物已加入 `.gitignore`；站点实名映射见本地文件 `sites_mapping.local.md`（不随仓库发布）。新增站点 = 新建 `site_x_<版本特征>/` 目录 + 目录内 README 说明版本特征与实测记录。
- **License**：待定。
