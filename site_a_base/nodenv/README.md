# nodenv — 高校组零依赖手写补环境（移植自 patent_cnipa/nodenv）

2026-09-02。本目录是 [patent_cnipa/nodenv](../../patent_cnipa/nodenv/)（专利局检索站 9/9 打通）
的移植，覆盖高校组 lzu / bupt / njnu 三校，实测 **15/15（200）**。

> 用法（父目录）: `python spider_nodenv.py --site lzu|bupt|njnu`。
> 原理、终局根因（400 → 0c → 200 三阶段史）与技术要点见源目录
> `patent_cnipa/nodenv/README.md`。本目录与源目录代码同源，差异仅在校准产物
> （cookie_writes.log 等运行时诊断文件，已 gitignore）。

## 文件

- `run_vm.js` / `env.js` / `trace_hooks.js` — 主入口 / 手写浏览器环境 / 插桩器
- `align_window.js` / `align_document.js` / `align_order.js` — 键集与键序对齐（sdenv 实测指纹）
- `jsdom_texts.json` / `xhr_proto.json` / `xhr_open_src.txt` — toString 指纹对齐资产

## 边界

- 川大 / 南理工为独立锁定模板（env_scu / env_njust，见父目录 README）——
  南理工是 meta-embedded 特殊形态，nodenv 的 classic 解析暂不支持。
