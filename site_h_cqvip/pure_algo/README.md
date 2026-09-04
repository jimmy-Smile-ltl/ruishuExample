# 纯算法 v11 — 维普期刊 (CQVIP) 瑞数6 纯算法路线（2026-09-05 实锤，5 轮稳定 200）

> 🔒 **开源策略**：本路线可运行代码（`spider_rs_v11.py` / `_gen_v11.js` / 插桩版 run_vm）
> **不开源**（防被直接用于大规模未授权采集）。本文档为完整技术记录——
> 密码体系破译结论、协议全解、插桩要点全部公开，供学习交流。
> 攻坚全程（v1-v23 备注）见 pro42 项目 `PURE_ALGO_NOTES.md`；本目录为**可复现的最终路线**（代码私有）。

---

## 一、路线概览

| 项 | 值 |
|----|----|
| 状态 | ✅ 回放 200 通关，5/5 轮稳定（167KB 期刊分类导航页） |
| 速度 | ~18s/轮（nodenv 取钥 15s + realDf 纯加密 ~1ms + 回放 1s） |
| 依赖 | 纯 Node（vm + 手写环境）+ curl_cffi；**无浏览器、无 jsdom** |
| 产物 | `6HZbKHDjIEcgT`（名 = O-cookie 名去尾 S + T），236 字符，同轮 O+P 组合回放 |

**链式流程**：`spider_rs_v11.py` 一键完成
412(O+nsd+cd) → `../nodenv --capture-inner` dump `enc_out.json`（a74/keys/a140 全捕获）
→ `_gen_v11.js` 纯加密生成 P-cookie → 同轮回放 200

---

## 二、密码体系破译（本路线的核心成果）

真实 VM 的密码 API（每轮标识符随机，结构固定）：

```js
function _$dG(key, random) {          // getCfg — 返回含两方法的对象
  [表0, 表1] = _$dO();                 // 标准 AES 表（与 rs cfgnum 逐值同构）
  cfg = _$jg(key, 表0, 表1);           // 密钥扩展（key 长%16≠0 时先剥 time 尾）

  return {
    _df(input, flag):                  // ★ CBC 加密 — 与 rs encryptMode1 同构
                                       //   max = floor(len/16)+1  ← 唯一差异!
                                       //   （rs 是 ceil+1 → 非16倍数输入多加密一块）
                                       //   flag=1: IV=4 随机 int 前缀; 无去填充
    _jW(input, flag):                  // ★ CFB 解密 — 与 rs encryptMode2 同构
                                       //   IV = 输入头 16B; idx=1 表; XOR 前一明文块;
                                       //   末字节值 = 去填充长度
  };
}
```

> **最大坑**：`_df` 的 `max = floor(len/16)+1`。rs 的 encryptMode1 是 `ceil+1`——
> 对非 16 倍数输入（如 74B）rs 会多加密一块（74→96B，真实是 74→80B）。
> v1-v22 所有「内层加密」穷举失败的真凶就是这一处 +1 差异。

**验证**：`_jW(input32, key21, 1)` 与真实输出 8 字节**逐字节一致**；
`_df(a74, keys17, 0)` 与 a140 尾 80 字节**逐字节一致**（本目录 `_gen_v11.js` 自带自检）。

---

## 三、v11 协议全解（5 次加密调用全实锤）

```
① 内层: tail80 = realDf(a74, keys17+time, 0)          // a74=74B 挑战事件数据 → 80B
② 组装: a140  = [2,8][t1(4B)][t2(4B)][48][a48(48B)][80][tail80]
③ 外层: a176  = realDf([uuid4(a140)][a140], keys16+time, 1, random)
④ 序列: cookie = '0' + numarr2string(a176)             // basestr 86 字符表
```

- **uuid** = rs uuid（CRC 类）——`uuid(a140) = a176 输入前 4 字节` 实锤
- **numarr2string** = rs 同款 3字节→4字符，字母表 = rs basestr（86 字符）
- **每轮 2 个 cookie 写**（2×内层+2×外层调用），t2-t1 ≈ 797ms，取第一组即可

---

## 四、关键结构事实

| 组件 | 事实 | 来源 |
|------|------|------|
| keys16 base | **227-base = 跨轮常量**（2 轮实锤）→ 可硬编码 | enc_log key21 剥 time |
| keys17 base | [8值][offset8] = 16B，每轮变 | enc_log 内层 key 剥 time |
| offset8 | = 任务 U14124020 的输出（rs tscd 硬编码该 UID → 每轮变 → 崩溃根因） | real_ans_dump task178 |
| t1/t2 | [0x6A9A.. 高16][低16]，≈ 挑战基值+毫秒增量（高16 随日期漂移） | a140[2:10] |
| a48 | 48B，= keys[2] 前缀（a48[1:17] = keys2-16 实锤） | a140[11:59] |
| a74 | 74B 挑战事件/硬件数据 —— **随机合成 → 412 拒（服务端校验内容）**，必须由 VM 生成 | enc_out 内层输入 |
| meta content | 96B 解码，独立挑战数据（≠ a74 密文） | 412 meta 标签 |

---

## 五、文件清单

| 文件 | 说明 |
|------|------|
| `spider_rs_v11.py` | 🔒 全链脚本（412→nodenv→生成→回放，带 4 次重试 + vm.js 校验），**不开源** |
| `_gen_v11.js` | 🔒 v11 协议生成器（realDf 纯加密链 + 自检），**不开源** |
| `../nodenv/run_vm.js` | 插桩版（`--capture-inner` 门控：enc 双包装器全局插桩 → `enc_out.json`）——**插桩版本不开源**，补环境原版开源 |

> 运行命令仅记录（代码私有）：`py -3.12 spider_rs_v11.py`（本目录，实测 200）。

> 坑：生成器必须以**绝对路径**传给 node（`cwd=rs-reverse` 时裸文件名会解析到 rs-reverse 里的旧副本 → 读错 enc_out → 跨轮混配 412）；
> 生成器内部不能用 `require('module-alias/register')`（本目录树无 node_modules），改为绝对路径 require rs-reverse 并手动注册 module-alias。

---

## 六、插桩要点（enc_out 捕获原理）

- 锚点正则（双包装器全局替换，**禁止双次求值返回值**）：
  `/function (_[\w$]+)\((_[\w$]+),(_[\w$]+),(_[\w$]+),(_[\w$]+)\)\{[^}]*?arguments\[2\]:1[^}]*?arguments\[3\]:0[^}]*?return ([^;}]+)/g`
- 注入只 log `{fn, key, in, mode}`（一次求值），**双次求值 out/outHead 会致 V8 原生崩溃**
- 分类：mode0 + 输入 70-80B = 内层(a74)；mode1 + 输入 144B = 外层
- **V8 崩溃教训**：`__seen[this]`（数组作对象键 → toString 递归）+ 返回值双次求值 = 两个崩溃源，均已移除

---

## 七、遗留（完全去 VM 化收尾，未阻塞）

1. **rs tscd 修复**：offset 任务按结构特征在 r2mka 树定位（替代硬编码 UID 'U14124020'）→ 用 rs 自带 dynamicExec 替换 nodenv 取钥（与 patent_cnipa 同档）
2. **a74 语义**：服务端校验内容 → 需比对 genKeys 键确认是否 VM 独有输出（若是，链式 nodenv 即终解）

**结论**：cookie 生成已 100% 纯算法（realDf 链，1ms 级）；取钥步 = nodenv（Node VM，非浏览器）。
若想进一步去 VM：修 rs tscd 的 offset 任务定位（本表第四节）。
