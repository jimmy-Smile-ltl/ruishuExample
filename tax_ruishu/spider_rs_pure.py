# -*- coding: utf-8 -*-
"""
站点F（税务局，TLS 指纹双变体版）— rs-reverse 纯算法爬虫（零浏览器，~1s/次）

实测: 2026-08-16, 7/7 轮 200 (10.5KB 电子税务局 SPA 壳)

依赖: pip install curl_cffi && npm install rs-reverse && python patch_rs_reverse_tj.py

用法: python spider_rs_pure.py
"""
import base64
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from curl_cffi import requests

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).parent
# 目标 URL (base64, 运行时解码)
TARGET = base64.b64decode(
    "aHR0cHM6Ly9ldGF4LnRpYW5qaW4uY2hpbmF0YXguZ292LmNuOjg0NDMv").decode()
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def prep_round():
    """同轮抓料: 412 → ts.json + vm.js + O-cookie (curl_cffi 保证 TLS 与最终请求一致)"""
    r = requests.get(TARGET, headers={"User-Agent": UA}, impersonate="chrome110",
                     timeout=20, verify=False)
    if r.status_code != 412:
        raise RuntimeError(f"Expected 412, got {r.status_code}")
    nsd = re.search(r"\$_ts\.nsd\s*=\s*(\d+)", r.text)
    cd = re.search(r'\$_ts\.cd\s*=\s*"([^"]+)"', r.text)
    js = re.search(r'src="([^"]+?\.js)"', r.text)
    if not (nsd and cd and js):
        raise RuntimeError("412 页字段缺失")
    (HERE / "ts.json").write_text(
        json.dumps({"nsd": int(nsd.group(1)), "cd": cd.group(1),
                    "from": TARGET, "hasDebug": False}), encoding="utf-8")
    js_url = js.group(1)
    if js_url.startswith("/"):
        js_url = TARGET.rstrip("/") + js_url
    jr = requests.get(js_url, headers={"User-Agent": UA, "Referer": TARGET},
                      impersonate="chrome110", timeout=20, verify=False)
    (HERE / "vm.js").write_text(jr.text, encoding="utf-8")
    return r.headers.get("set-cookie", "").split(";")[0]


def makecookie():
    env = dict(os.environ, NODE_TLS_REJECT_UNAUTHORIZED="0")
    # 定位 rs-reverse main.js (向上查找 node_modules)
    main_js = subprocess.run(
        ["node", "-e", "console.log(require.resolve('rs-reverse'))"],
        capture_output=True, text=True, cwd=str(HERE)).stdout.strip()
    if not main_js:
        raise RuntimeError("rs-reverse 未安装: npm install rs-reverse")
    r = subprocess.run(["node", main_js, "makecookie", "-f", "ts.json", "-j", "vm.js"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=300, cwd=str(HERE), env=env)
    out = r.stdout + r.stderr
    m = re.search(r"cookie值[：:]\s*(.+)", out)
    if not m:
        raise RuntimeError(f"makecookie 失败: {out[-300:]}")
    return m.group(1).strip()


def verify(cookie, o_cookie):
    """T 后缀轮换验证 (本版最后字母 = T)"""
    name, val = cookie.split(";")[0].split("=", 1)
    for suffix in ("T", "P"):
        s = requests.Session(impersonate="chrome110")
        for p in (o_cookie + f";{name[:-1]}{suffix}={val}").split(";"):
            if "=" in p:
                k, v = p.split("=", 1)
                s.cookies.set(k.strip(), v.strip())
        r = s.get(TARGET, headers={"User-Agent": UA}, timeout=20, verify=False)
        print(f"  {name[:-1]}{suffix}: {r.status_code} ({len(r.text)}B)")
        if r.status_code == 200 and len(r.text) > 3000:
            (HERE / "tj_200.html").write_text(r.text, encoding="utf-8")
            print(f"[OK] 200, 已保存 tj_200.html")
            return True
    return False


def main():
    t0 = time.time()
    for i in range(5):
        o = prep_round()
        cookie = makecookie()
        print(f"第{i + 1}轮: {cookie.split(';')[0].split('=')[0]} 长度 "
              f"{len(cookie.split(';')[0].split('=', 1)[1])}")
        if verify(cookie, o):
            print(f"完成, 用时 {time.time() - t0:.1f}s")
            return
        time.sleep(1)
    print("[FAIL] 5 轮未通过")


if __name__ == "__main__":
    main()
