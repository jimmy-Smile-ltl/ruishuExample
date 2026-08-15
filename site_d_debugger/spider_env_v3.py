# -*- coding: utf-8 -*-
"""
站点D（药品监管部门）— 手写补环境 v3 爬虫（零依赖实验路线）

原理:
  1. curl_cffi (chrome110) 拿 412 → 保存 412.html + vm.js 到 shared/
  2. node build_env.js (纯手写 mock + native_patch.js 原生伪装层)
     → 真实 VM 执行 → P-cookie (~1s)
  3. O+P 组合, T/P 名轮换验证 → 200

状态 (2026-08-15 v2): 同轮多跑 + 200 双复验稳定化后 10/10 轮稳定通过。
  机制: 校准值 (execNumberByTime) 每次运行浮动 → 服务器窗口边缘彩票,
  同轮重跑换校准值 + 复验防假通过 → 100% 收敛 (平均 2.3 跑/轮)。
  ★ 生产首选 spider_rs_pure.py (纯算法, 无环境依赖, 更快)。

依赖: pip install curl_cffi (Node 侧零依赖, 无需 npm install)

用法:
  python spider_env_v3.py                       # 数据查询页
  python spider_env_v3.py --url <URL> --rounds 6
"""
import argparse
import base64
import re
import subprocess
import sys
import time
from pathlib import Path

from curl_cffi import requests

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SCRIPT_DIR = Path(__file__).parent
SHARED = SCRIPT_DIR / "shared"
SHARED.mkdir(exist_ok=True)
BASE_URL = base64.b64decode("aHR0cHM6Ly93d3cubm1wYS5nb3YuY24=").decode()
TARGET_URL = BASE_URL + "/datasearch/"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36")


def prep_round(url):
    """curl_cffi 拿 412 → shared/412.html + shared/vm.js + O-cookie"""
    s = requests.Session()
    resp = s.get(url, headers={"User-Agent": UA}, impersonate="chrome110", timeout=15)
    if resp.status_code != 412:
        raise RuntimeError(f"Expected 412, got {resp.status_code}")
    (SHARED / "412.html").write_text(resp.text, encoding="utf-8")
    m = re.search(r"<script[^>]*src=\"(/[^\"]+\.js)\"", resp.text)
    if not m:
        raise RuntimeError("412 页未找到 VM script")
    vm = s.get(BASE_URL + m.group(1), headers={"User-Agent": UA},
               impersonate="chrome110", timeout=15).text
    (SHARED / "vm.js").write_text(vm, encoding="utf-8")
    return "; ".join(f"{k}={v}" for k, v in s.cookies.items())


def gen_p_cookie():
    """node build_env.js → document.cookie 的 P 部分"""
    r = subprocess.run(["node", "build_env.js"], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=90,
                       cwd=str(SCRIPT_DIR))
    for p in r.stdout.strip().split(";"):
        p = p.strip()
        if "=" in p:
            k, _, v = p.partition("=")
            if len(v) > 150:
                return k, v
    return None, None


def get_session(url, max_rounds=6, max_runs=6, verbose=True):
    """v2 稳定化: 同轮内多跑 (校准值彩票) + 200 双复验"""
    for i in range(1, max_rounds + 1):
        try:
            o = prep_round(url)
        except RuntimeError as e:
            if verbose:
                print(f"[第{i}轮] {e}")
            continue
        for k in range(1, max_runs + 1):
            name, val = gen_p_cookie()
            if not val:
                continue
            base = name[:-1]
            for suffix in ("T", "P"):
                s = requests.Session()
                for part in (o + f";{base}{suffix}={val}").split(";"):
                    part = part.strip()
                    if "=" in part:
                        kk, vv = part.split("=", 1)
                        s.cookies.set(kk.strip(), vv.strip())
                statuses = []
                for attempt in range(3):  # 首次200必须复验 (防假通过)
                    r = s.get(url, headers={"User-Agent": UA},
                              impersonate="chrome110", timeout=20)
                    statuses.append(r.status_code)
                    if r.status_code != 200:
                        break
                    time.sleep(1)
                if statuses and all(st == 200 for st in statuses):
                    if verbose:
                        print(f"[第{i}轮 第{k}跑] ✅ {base}{suffix} 稳定通过 "
                              f"(P-cookie {len(val)} chars)")
                    return s
        if verbose:
            print(f"[第{i}轮] {max_runs} 跑全灭, 换轮")
    raise RuntimeError(f"{max_rounds} 轮内未稳定通过")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=TARGET_URL)
    ap.add_argument("--rounds", type=int, default=6)
    args = ap.parse_args()

    print("=" * 60)
    print("手写补环境 v3 (零依赖) — 站点D 瑞数")
    print("=" * 60)

    s = get_session(args.url, max_rounds=args.rounds)
    r = s.get(args.url, headers={"User-Agent": UA}, impersonate="chrome110", timeout=20)
    m = re.search(r"<title>([^<]*)</title>", r.text)
    print(f"\n[{r.status_code}] {args.url}")
    print(f"标题: {m.group(1).strip() if m else '?'}, 大小: {len(r.text)}b")
