"""
spider_iv8.py — 站点I（海关信用系统）iv8 运行时路线 ✅ 已通

iv8 = Python 原生 V8 + C++ 层浏览器环境（pip install iv8, 社区版非商用许可,
      github.com/HanZzzzz000/iv8）。瑞数 VM 在 iv8 里执行出 P cookie, 回放即 200。

★ 实测 (2026-09-05, iv8 0.1.4): ✅ 200（13191b, 1.0s, 2 轮: 412 → iv8 → 200）

链路:
  requests 抓 412 挑战页（Set-Cookie O）
    → iv8 page.load 离线执行挑战 VM → document.cookie 生成 O+P
    → O+P 回放 → 200

攻克史（两层根因, 均在本库定位并修复）:
  1. http 明文站 + cookie 带 `; Secure` 被 iv8 0.1.4 整体丢弃
     （真 Chrome 在非 https 页忽略 Secure 照存）→ iv8_kit 自动装剥离 hook
  2. 多轮挑战复用 JSContext 会因 window.$_ts 残留污染导致第 2 轮起 VM 不写 P
     → 每轮挑战用全新 JSContext（对齐 nodenv 每轮全新 node 进程的做法）

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

import requests

requests.packages.urllib3.disable_warnings()

from iv8_ruishu_util import UA_CHROME114, chain_get, report

# 目标 URL (base64, 运行时解码; 实名映射见仓库根 sites_mapping.local.md)
_B = lambda s: base64.b64decode(s).decode()
PAGE_URL = _B("aHR0cDovL2NyZWRpdC5jdXN0b21zLmdvdi5jbi9jY3Bwd2Vic2VydmVyL3BhZ2VzL2NjcHAvaHRtbC9kaXJlY3RvcnkuaHRtbA==")

HEADERS = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Content-Type": "application/json; charset=UTF-8",
    "Origin": "http://credit.customs.gov.cn",
    "Pragma": "no-cache",
    "Referer": "http://credit.customs.gov.cn/ccppwebserver/pages/ccpp/html/directory.html",
    "User-Agent": UA_CHROME114,
    "X-Requested-With": "XMLHttpRequest",
}

if __name__ == "__main__":
    s = requests.Session()
    t0 = time.time()
    resp = chain_get(s, PAGE_URL, HEADERS, max_rounds=3)
    report("站点I·海关信用系统", PAGE_URL, resp, time.time() - t0)
    if resp is not None and resp.status_code == 200:
        # 页面为 GBK 编码, 如需解析: resp.content.decode('gbk', errors='replace')
        try:
            print("  cookies:", dict(s.cookies))
        except Exception:
            print("  cookies: (同轮多路径冲突, 见 session.cookies)")
