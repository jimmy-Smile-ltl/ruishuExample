# handpatch — 专利局手动补环境（失败经验沉淀，非可行方案）

2026-08-15。目标：不用 sdenv/jsdom，纯手写 Node 环境伪装浏览器跑瑞数 VM 出有效 P-cookie。
**结果：❌ 失败** — VM 正常运行、cookie 233 chars 成形，但服务端 400 拒收。已放弃，
本目录保留失败证据链与诊断方法论（对同类站点有参考价值）。

> ⚠️ **2026-09-01 更新：手写补环境路线已由 `../nodenv/` 打通（200 实测 9/9，13.2-13.8s）**。
> 本目录是 08-15 的早期尝试（233c 恒 400，缺 window/document 键集对齐等 8 处修复 +
> env cookie setter 时间源 bug），仅作历史归档。新方案见 `../nodenv/README.md`
> （含终局根因：setter 过期判断宿主时间 vs VM fixdate 错位误删 cookie）。

## 状态

| 项 | 状态 |
|----|------|
| 架构 | ✅ vm.createContext 干净沙箱 + 手写 DOM/API + native 形态伪装 |
| VM 运行 | ✅ 195KB VM 正常加载执行，boot 前半段与 sdenv 逐事件对齐 |
| Cookie 生成 | ⚠️ 233 chars（sdenv: 264~285），服务端 400 拒收 |
| 前沿 | 分叉点已定位（codegen phase-2 未执行），未突破即放弃 |

## 失败证据链（最后定位到的分叉点）

1. **codegen 完整运行但只跑 phase-1**: 插桩实测 6990 ops 完整跑完（cd 逐字符解码循环），
   但第二条流（`if(X<74)`，phase-2）从未执行。
2. **$_ts 终态对比**: sdenv cookie 完成后 `{l__: fn}`（nsd/cd/scj/aebi 全部清空）；
   mine `{nsd:undefined, cd:undefined, scj:[], aebi:[...], ...VM内部变量}`。
3. **sdenv 流程异步、mine 全同步**: sdenv 1.5-3.7s 间完成 cookie；mine 1.5s 内全动作。
4. **keys 材料在 phase-2 产出** — 补环境没有 keys → cookie 密码学材料缺失 → 400。
   （rs-reverse 纯算法侧: phase-2 跑了但 offset 错 [codemap bug]，两条路各卡一边。）

## 诊断方法论（本目录核心资产）

1. **sdenv 参照系**: sdenv 能过（285c 被接受），用它做 API 访问面测量（包 own 属性
   getter + 方法包日志，不换对象避免破坏 jsdom）。
2. **全序列 diff**: 两环境记录同款 `W:xxx`/`D:xxx` 事件序列，逐行 diff 找第一个分叉。
3. **eval 捕获**: 包 win.eval 抓 VM 代码生成器产出（283KB 解释器 + 字节码 dispatch）。
4. **Error 构造日志**: 沙箱 Error 类带 stack 日志，抓 VM 静默 catch 的异常。

## 手写环境必须满足的硬门槛（逐个修复过）

- `[native code]` 形态: DOM 方法 / Event / XHR / atob / btoa 全要 native toString（jsdom 全是）
- Node 内建泄露: `window.top`/`parent` 指向 globalThis 会暴露 process/Buffer → 必须 vm.createContext
- 集合类型: getElementsByTagName 返回 HTMLCollection（有 item），裸数组被检测
- 锚点 URL 解析: `createElement('a').href='相对路径'` 要自动解析 host 等字段
- `parentNode` 只读语义: `el.parentNode = X` 静默失败保持 null（VM 检查此浏览器行为）
- load 事件延迟: sdenv 的 load 回调等所有 time-0 timer 完成后触发（源码注释「瑞数：2」）
- VM 会真实 fetch（把自己函数 set 到 window.fetch），但挑战页流程实际完全离线

## 用法（仅供研究复现）

```bash
python test_chain.py pro38 --debug   # 链式: curl_cffi 挑战页 → node run_vm → 回放
node run_vm.js <挑战页.html> <URL> --debug   # 单独跑 VM
```

## 文件

- `env.js` (44KB) — 手写浏览器环境核心（setGlobal / makeNative / DOM 树 / Canvas/WebGL 指纹）
- `run_vm.js` (20KB) — VM 执行器（沙箱 + 脚本序列 + 诊断插桩）
- `test_chain.py` — 链式验证（pro38 检索站 / epub 通用）

## 纯算法路线 (rs-reverse) 同族结论 (2026-08-16)

makecode 53ms 成功、makecookie 走到 offset 任务 `[5,155,2,3,5,5,6,4]`，但 genKeys 校验失败 —
epub VM 的 keys 尾部编码改了布局（4 字节周期结构 vs gap 编码），各种编码假设全部排除后放弃。
两条路（补环境 phase-1 / rs-reverse phase-2）各有缺口，未衔接上。
