# nodenv — 专利局瑞数6 零依赖手写补环境（已打通，200 ✅）

2026-09-01。不用 sdenv/jsdom，纯手写 Node vm 沙箱跑瑞数 VM，生成 P-cookie 回放 **200 通关（9/9 稳定，13.2-13.8s/轮）**。

> 用法（父目录）: `python spider_nodenv.py` — curl_cffi 抓 412 → 本目录 run_vm.js 出 P-cookie → 200。
> 零 npm 依赖（不需要 sdenv），node 版本 ≥ 18 即可。

## 文件

```
nodenv/
├── run_vm.js             # ★ 主入口: vm.createContext(DONT_CONTEXTIFY) + 挑战页执行 + cookie 轮询
├── env.js                # ★ 手写浏览器环境: window/document/navigator/canvas/xhr + cookie 容器
├── trace_hooks.js        #   插桩器 (仅 --trace-task 诊断模式加载; 生产 --no-instrument 零开销)
├── align_order.js        #   sdenv 实测 window 键序 + CSS 类源码 (指纹对齐)
├── align_window.js       #   window 键集合对齐 jsdom 实测 248 keys
├── align_document.js     #   document 键集合对齐 (217 键) + 原型细节
├── jsdom_texts.json      #   jsdom WebIDL 函数源码文本 (fakePTS toString 对齐)
├── xhr_proto.json        #   XMLHttpRequest 原型键集对齐
└── xhr_open_src.txt      #   jsdom XHR open 源码文本 (toString 指纹)
```

## 终局根因（2026-09-01，教训沉淀）

历史三阶段：

| 阶段 | 现象 | 根因 |
|------|------|------|
| 2026-08-19 | 357c 恒 400 | 8 处环境差异（window 键集/document 键集/navigator 形态/matchMedia 返回等），cookie 密码学材料无效 |
| 2026-08-31 | 0 chars | 上述修复后，**env.js cookie setter 过期判断用宿主真实 Date.now 误判 VM fixdate 的 expires 为过期 → 主 cookie 写完即删**（写成功却读空的幽灵 bug） |
| 2026-09-01 | **200 终局** | setter 判断基准对齐 VM 时间源：`buildEnv({fixDateMs})` → `__nowBase = fixDateMs || Date.now()` |

**核心教训**：env 宿主侧与 VM 沙箱侧的时间源必须一致。VM 内 `--fixdate` 只覆盖 ctx.Date，
env 侧的 cookie/缓存逻辑仍走宿主 `Date.now()`，两者错位即产生静默删除。

### 当日排除链（证明"环境已对齐到任务流逐字节一致"）

- 随机数：N/S 前 120 次 Math.random 调用点**逐位一致**（LCG 同种子不漂移）
- 任务流：0-106（cookie 构建）任务两侧均执行 2 次、前 274 行值行完全一致；
  BT boot 序列 45 项 PC 逐位一致
- 结论：**写入侧一直正常**（两次 412c 完整值命中 setter），问题只在 env 读取/删除侧

## 技术要点（本方案与 sdenv 的本质差异）

- `vm.createContext(vm.constants.DONT_CONTEXTIFY)` — 上下文全局就是 window，裸赋值不移动枚举顺序
- window = Proxy(ctx) — ownKeys 陷阱过滤 `_` 前缀内部键；收集器走内部 for-in 视图
- fakePTS 三分支 toString：`__anonSrc`（B 函数）/ NATIVE_FNS / ENV_FNS 查 jsdom_texts.json
- cookie 容器 + docProto 原型访问器（enumerable:false，与 jsdom 对齐）

## 相关

- 同目录失败前身 `../handpatch/`（2026-08-15 早期尝试，233c 恒 400，保留证据链）
- sdenv 参照方案 `../spider_sdenv.py`（jsdom 环境，9.9-20s 也通）
- 纯算法侧 rs-reverse 见 pro38 归档
