# 站点A（高校组）— 兰州/南师 瑞数纯算法还原（rs-reverse 2026 变体）

来源：高校组瑞数实战（pro36），**2026-09-05 凌晨实测 200**。两校纯算法方案（兰州大学、
南京师范大学），从零生成 P cookie 回放 200。附通用化组件，同族新校可复用。

> 🔒 **开源策略**：本路线可运行代码（`spider_pure.py` / `rs_school_extract.js` /
> `rs_school_gen.js` / `patches/` 补丁）**不开源**（防被直接用于大规模未授权采集）。
> 本文档为完整技术记录：密码链还原结论、三处 2026 变体的坑、模板公式全部公开。
> 想直接跑通高校站请使用父目录开源的补环境路线（nodenv / sdenv / CDP / ruyiPage）。

> 匿名化说明：官网 URL 为 base64 编码。解码：
> `echo <b64> | base64 -d`（bash）/ `[Convert]::FromBase64String("<b64>")`（PowerShell）。

## 目标站点

| 高校 | 官网 (base64) | 纯算法状态（2026-09-05） |
|------|--------------|-------------------------|
| 兰州大学（985） | `aHR0cHM6Ly93d3cubHp1LmVkdS5jbg==` | ✅ 从零生成 P 回放 200（2/2 轮） |
| 南京师范大学（211） | `aHR0cHM6Ly93d3cubmpudS5lZHUuY24=` | ✅ 从零生成 P 回放 200（1/1 轮） |
| 北京邮电大学（211） | `aHR0cHM6Ly93d3cuYnVwdC5lZHUuY24=` | ✅ 从零生成 P 回放 200（1/1 轮，S 形态回放用 T 名） |
| 四川大学（985） | `aHR0cHM6Ly93d3cuc2N1LmVkdS5jbg==` | —（当前 WAF 已撤，200 直通；09-04 曾打通 202 变体注入模式） |
| 南京理工大学（211） | `aHR0cHM6Ly93d3cubmp1c3QuZWR1LmNu` | ❌ 瑞数 **5 代**（P 开头 5、138KB VM、202+S+T 形态），meta 需 boot-VM 解码 |

## 当前口径（重要）

纯算法密码链已**完全还原**（从零生成的 na 与真 VM 逐字节一致），但
**basearr（指纹数组）仍由同轮 nodenv 提供**——basearr 必须同轮新鲜（旧模板复用
5/5 全 412），其结构随轮由 VM 任务树决定（scu 的 D-区同款墙）。basearr 模板化完成后
可完全去 VM。**纯算法方案 = 同轮 basearr + 从零生成**（无需浏览器，nodenv 仅取指纹）。

## 挑战流程（2026 变体，与 202 变体/scu 不同）

```
① GET 目标页 (无 cookie) → 412 + Set-Cookie: <名>O + [$_ts.nsd/cd] + [VM 解释器 JS]
② nodenv（同轮）跑 VM → P cookie（真 P，解码出 basearr）
③ 从 cp0 提取真字母表（结构 oracle）→ 解码真 P → na + 真 basearr
④ 从零生成：basearr → huffman → Feistel-CBC(addTime(keys17)) → na
   → uuid=CRC32(na[4:]) → Feistel-CBC(addTime(keys16)) → 'a'/'0'+编码(真字母表) = P
⑤ GET 目标页（O + P + enable_<名>T=true）→ 200 ✅
```

## 关键配方（2026 变体实测）

```js
// 外层（与老版本一致）
P = prefix + encode4x3( FeistelCBC(na, numarrAddTime(keys16, r2mkaTime)[0], flag=1), alphabet )
na = [uuid4=CRC32(na[4:]), 2, 8, r2mkaTime4, startTime4(=r2mkaTime+delta), keys2len,
      keys2(48B), (128), encLen, enc]

// 内层（2026 变体与 scu 不同：无 XOR！）
enc = FeistelCBC( huffman(basearr, rs树), numarrAddTime(keys17, r2mkaTime)[0], flag=0 )
// scu/202 变体 = 有 XOR keys2[:16]；2026 变体 = 无 XOR
```

三处 2026 变体的坑（此前全卡在这里）：

| # | 坑 | 现象 | 修复 |
|---|----|------|------|
| 1 | **真字母表在 cp0 里**（如 lzu = '.'→'-' 变体），rs-reverse 硬编码 basestr 错 | P 解码错 → 全部 CRC NO | 从 `parse($_ts.cp[0])` 结构 oracle 检出（`rs_school_extract.js`） |
| 2 | **cd 也用真字母表编码** | 硬编码 decryptKeys 在 '-' 位置解出 >255 脏字节 → keys2/keys17 部分字节错 → 内层解密失败（keys16 恰好躲过 → 外层一直对，极具迷惑性） | tscp 后重建 decryptKeys 并在 constData 后设回 |
| 3 | 前缀 'a'/'0' 各校不同 | 前缀错 → 全错 | 从真 P 首字符自动取 |

## 用法

前置：pro36 的 patched rs-reverse（含 RS_TEMPLATE 偏移模板分支 + tscd 递归守卫，
见 `patches/`）+ 父目录 `nodenv/`（同轮取 basearr）。

```bash
# 全链（抓 412 → nodenv 取 basearr → 从零生成 → O→P 改名回放）
python spider_pure.py lzu     # 或 njnu

# 分步（调试用）
node rs_school_extract.js     # RS_P=<真P> RS_TEMPLATE=1 → na.json + basearr.json
node rs_school_gen.js         # RS_BA=<basearr> RS_TIME=<秒> RS_PREFIX=<a|0> ... → P
```

成功输出：控制台打印 `纯算法生成P: 200`（nodenv原P 200 为对照）。

## 关键文件

| 文件 | 说明 |
|------|------|
| `spider_pure.py` | 🔒 全链调度：412 → nodenv → 提取 → 从零生成 → 回放（**不开源**） |
| `rs_school_extract.js` | 🔒 字母表结构 oracle + 真 P 解码 → na + 真 basearr（**不开源**） |
| `rs_school_gen.js` | 🔒 从零生成器（**不开源**） |
| `patches/` | rs-reverse 必须的补丁说明（decryptKeys 修复 + tscd 递归守卫 + 偏移模板），**文档开源、补丁代码私有** |
| `README.md` | 本文件（技术记录，开源） |

## 实测记录（2026-09-05）

| 校 | 字母表 | 前缀 | hasDebug | delta | 纯算法生成 P |
|----|--------|------|----------|-------|-------------|
| lzu | cp0[622]（'-' 版） | 'a' | 有（128） | 5 | **200**（2/2 轮） |
| njnu | cp0[813]（'.' 版，自动检出） | '0' | 无 | 2 | **200**（1/1 轮） |

- 生成的 na 与真 VM 逐字节一致（diff 0/209）
- 服务器不校验 IV（随机 IV 200）——生成端无需还原 IV 公式
- 挑战非一次性：同轮 O+P 时间窗（~2min）内可多次 200；超窗 412
- 模板 offsets（`RS_TEMPLATE`，`offsets[i]=cdTail[i]^[45,2,54,52,2,54,52,48]`）在
  ~70-80% 轮次有效；异常轮重试即可（~30s/轮）

## 剩余墙

1. **basearr 模板化**（去 nodenv 依赖）：basearr 必须同轮新鲜；结构 = 随机头部 +
   （可选 hostname）+ 经典段（74 值，仅 X,Y 两字节随机）+ 尾部段（组合随轮变）。
   hostname 非必需（无 hostname 的轮照样 200）。经典段跨轮恒定：
   `[3,73,1,0,33,128,159,173,0,238,8,"MacIntel",0,0,X,Y,50,8,0,0,1,0×7,3,0,4,0,3,0,4,0×6,7,0×7,121,211,210,212,0×12]`
2. ~~bupt~~ **✅ 已通（2026-09-05 夜）**：回放命名修复 = **S 形态用 T 名**（S 名去尾+T，
   非 P 名！）——此前全 412 是改名错误 + 陈旧轮。修复后纯算法生成 200（1/1）。
   na 的 [6..9]=挑战铸造时刻（缓存 ~9.5min）、[10..13]=运行时刻的语义服务端接受，
   无需特殊处理；生成端直接沿用 na 原时间即可。
3. **njust**：**瑞数 5 代**（非 6 代！）实锤：P = 173c 开头 '5'（版本速查表的 5 代标记）、
   vm = 138KB、202 + S cookie（FSSBBIl1UgzbN7NS）→ 回放 T 名（FSSBBIl1UgzbN7NT，
   同 bupt 的 S→T）。env_njust runner 出 P 171-173c ✓（补环境侧可用）。
   纯算法实测：meta 直接当 cd → offsets 负值垃圾（`[-46,2,54,...]`）→ 字母表未命中。
   下一步 = 21KB boot-VM（`_$aG` 字节码解释器）的 meta→cd 解码 + 5 代 key 派生，
   或沿用 5 代专用适配器路线。
