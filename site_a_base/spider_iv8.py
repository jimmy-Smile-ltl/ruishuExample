"""
spider_iv8.py — 站点A（高校组）iv8 运行时路线 ✅ 5/5 校已通

iv8 = Python 原生 V8 + C++ 层浏览器环境（pip install iv8, 社区版非商用许可,
      github.com/HanZzzzz000/iv8）。

★ 实测 (2026-09-05, iv8 0.1.4):
  兰州大学 ✅ 200（153227b, 3.6s）   南京师范大学 ✅ 200（259475b, 1.4s）
  北京邮电大学 ✅ 200（95611b, 1.0s） 南京理工大学 ✅ 200（89279b, 1.1s, 202 形态）
  四川大学 ✅ 直通 200（无 WAF）
  对比 nodenv 13.4-14.4s / sdenv 13-15s —— iv8 约 1/10 耗时, 免 npm、免浏览器

链路: 412/202 挑战 → iv8 page.load 执行 VM → document.cookie → 回放 → 200

依赖: pip install iv8 curl_cffi
用法: python spider_iv8.py --site bupt|lzu|njnu|njust|scu [--rounds=3]
"""

import sys
import time
import base64
import argparse
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

for _p in Path(__file__).resolve().parents:
    if (_p / "iv8_kit").is_dir():
        sys.path.insert(0, str(_p / "iv8_kit"))
        break

import curl_cffi.requests as req

from iv8_ruishu_util import UA_CHROME114, chain_get, report

# 目标 URL (base64, 运行时解码; 实名映射见仓库根 sites_mapping.local.md)
_B = lambda s: base64.b64decode(s).decode()
SITES = {
    "lzu":   _B("aHR0cHM6Ly93d3cubHp1LmVkdS5jbi8="),
    "scu":   _B("aHR0cHM6Ly93d3cuc2N1LmVkdS5jbi8="),
    "bupt":  _B("aHR0cHM6Ly93d3cuYnVwdC5lZHUuY24v"),
    "njnu":  _B("aHR0cHM6Ly93d3cubmpudS5lZHUuY24v"),
    "njust": _B("aHR0cHM6Ly93d3cubmp1c3QuZWR1LmNuLw=="),
}
SITE_NAMES = {
    "lzu": "兰州大学", "scu": "四川大学", "bupt": "北京邮电大学",
    "njnu": "南京师范大学", "njust": "南京理工大学",
}
UA = UA_CHROME114


def main():
    ap = argparse.ArgumentParser(description="站点A iv8 瑞数链式验证 (412/202 → iv8 → 200)")
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--site", default="bupt", choices=list(SITES))
    args = ap.parse_args()
    page_url = SITES[args.site]

    s = req.Session(impersonate="chrome110")
    headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Referer": page_url,
        "User-Agent": UA,
    }
    t0 = time.time()
    resp = chain_get(s, page_url, headers, max_rounds=args.rounds)
    report(f"站点A·{SITE_NAMES[args.site]}", page_url, resp, time.time() - t0)
    if resp is not None and resp.status_code == 200:
        try:
            print("  cookies:", dict(s.cookies))
        except Exception:
            print("  cookies: (同轮多路径冲突, 见 session.cookies)")


if __name__ == "__main__":
    main()
