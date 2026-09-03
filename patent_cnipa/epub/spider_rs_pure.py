# -*- coding: utf-8 -*-
"""
epub 纯算法爬虫 — rs-reverse len133-encrypt111 适配器（零浏览器，~1s/次）

实测: 2026-09-03, 202 → P-cookie 257c → 200 (15380b)

依赖: pip install curl_cffi + rs-reverse（npm install rs-reverse，
     或环境变量 RS_REVERSE_DIR 指向本地 clone 的包根目录）

用法: python spider_rs_pure.py [--rounds=5]
"""
import json
import os
import re
import base64
import subprocess
import sys
import time
from pathlib import Path

from curl_cffi import requests

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).parent
# 目标 URL (base64, 运行时解码)
TARGET = base64.b64decode("aHR0cDovL2VwdWIuY25pcGEuZ292LmNuLw==").decode()


def _find_rs_reverse():
    """定位 rs-reverse 包根: 环境变量 > npm 安装 > 同级项目 clone (不硬编码具体目录)"""
    env_dir = os.environ.get('RS_REVERSE_DIR', '')
    if env_dir and (Path(env_dir) / 'main.js').exists():
        return Path(env_dir)
    try:
        r = subprocess.run(
            ["node", "-e", "console.log(require.resolve('rs-reverse/package.json'))"],
            capture_output=True, text=True, timeout=30)
        p = Path(r.stdout.strip())
        if r.returncode == 0 and p.exists():
            return p.parent
    except Exception:
        pass
    other = HERE.parents[4] / "spider research" / "其他"
    if other.exists():
        for proj in sorted(other.iterdir()):
            cand = proj / "rs-reverse"
            if (cand / "main.js").exists():
                return cand
    return None


RS_REVERSE = _find_rs_reverse()
if RS_REVERSE is None:
    raise SystemExit("[FATAL] 找不到 rs-reverse — npm install rs-reverse 或设置 RS_REVERSE_DIR")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36")


def prep_round():
    """同轮抓料: 202 → ts.json + vm.js + O-cookie"""
    r = requests.get(TARGET, headers={"User-Agent": UA}, impersonate="chrome110",
                     timeout=20)
    if r.status_code != 202:
        raise RuntimeError(f"Expected 202, got {r.status_code}")
    nsd = re.search(r"\$_ts\.nsd\s*=\s*(\d+)", r.text)
    cd = re.search(r'\$_ts\.cd\s*=\s*"([^"]+)"', r.text)
    js = re.search(r'src="([^"]+?\.js)"', r.text)
    if not (nsd and cd and js):
        raise RuntimeError("202 页字段缺失")
    (RS_REVERSE / "ts.json").write_text(
        json.dumps({"nsd": int(nsd.group(1)), "cd": cd.group(1),
                    "from": TARGET, "hasDebug": False}), encoding="utf-8")
    js_url = js.group(1)
    if js_url.startswith("/"):
        js_url = TARGET.rstrip("/") + js_url
    jr = requests.get(js_url, headers={"User-Agent": UA, "Referer": TARGET},
                      impersonate="chrome110", timeout=20)
    (RS_REVERSE / "vm.js").write_text(jr.text, encoding="utf-8")
    return r.headers.get("set-cookie", "").split(";")[0]


def makecookie():
    r = subprocess.run(["node", "main.js", "makecookie", "-f", "ts.json", "-j", "vm.js"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=300, cwd=str(RS_REVERSE))
    out = r.stdout + r.stderr
    m = re.search(r"cookie值[：:]\s*(.+)", out)
    if not m:
        raise RuntimeError(f"makecookie 失败: {out[-400:]}")
    return m.group(1).strip()


def main():
    rounds = int(sys.argv[sys.argv.index("--rounds") + 1]) if "--rounds" in sys.argv else 5
    t0 = time.time()
    for i in range(rounds):
        try:
            o_cookie = prep_round()
            cookie = makecookie()
        except Exception as e:
            print(f"第{i+1}轮失败: {e}")
            time.sleep(2)
            continue
        name, val = cookie.split(";")[0].split("=", 1)
        print(f"第{i+1}轮: {name} 长度 {len(val)} (O={o_cookie.split('=')[0]})")
        s = requests.Session(impersonate="chrome110")
        for p in (o_cookie + ";" + cookie).split(";"):
            p = p.strip()
            if "=" in p:
                k, v = p.split("=", 1)
                s.cookies.set(k.strip(), v.strip())
        r = s.get(TARGET, headers={"User-Agent": UA}, timeout=20)
        print(f"  回放: {r.status_code} ({len(r.text)}B)")
        if r.status_code == 200 and len(r.text) > 3000:
            print(f"✅ 完成, 用时 {time.time() - t0:.1f}s")
            return
        time.sleep(1)
    print("[FAIL] 未通过")


if __name__ == "__main__":
    main()
