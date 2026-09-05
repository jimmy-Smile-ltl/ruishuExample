"""
站点H（维普期刊, 6 代 classic, 与站点G同族）iv8 运行时路线 ✅ 已通

iv8 = Python 原生 V8 + C++ 层浏览器环境（pip install iv8, 社区版非商用许可,
      github.com/HanZzzzz000/iv8）。

★ 实测 (2026-09-05, iv8 0.1.4): ✅ 200（167850b, 1.6s, 2 轮）
  对比: nodenv ~14s / sdenv 7-11.5s —— iv8 约 1/10 耗时

链路: 412 挑战 → iv8 page.load 执行 VM → document.cookie → 回放 → 200
依赖: pip install iv8 requests
用法: python spider_iv8.py
"""

import sys
import time
import base64
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

for _p in Path(__file__).resolve().parents:
    if (_p / "iv8_kit").is_dir():
        sys.path.insert(0, str(_p / "iv8_kit"))
        break



from iv8_ruishu_util import UA_CHROME114, chain_get, report

# 目标 URL (base64, 运行时解码; 实名映射见仓库根 sites_mapping.local.md)
_B = lambda s: base64.b64decode(s).decode()
PAGE_URL = _B("aHR0cHM6Ly9xaWthbi5jcXZpcC5jb20vUWlrYW4vSm91cm5hbC9Kb3VybmFsR3VpZD9mcm9tPWluZGV4")

HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Referer": PAGE_URL,
    "User-Agent": UA_CHROME114,
}

if __name__ == "__main__":
    import requests
    requests.packages.urllib3.disable_warnings()
    s = requests.Session()
    t0 = time.time()
    resp = chain_get(s, PAGE_URL, HEADERS, max_rounds=3)
    report('站点H·维普期刊', PAGE_URL, resp, time.time() - t0)
    if resp is not None and resp.status_code == 200:
        try:
            print("  cookies:", dict(s.cookies))
        except Exception:
            print("  cookies: (同轮多路径冲突, 见 session.cookies)")
