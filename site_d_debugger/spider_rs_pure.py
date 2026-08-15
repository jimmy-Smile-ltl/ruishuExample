# -*- coding: utf-8 -*-
"""
站点D（药品监管部门）— 瑞数纯算法还原爬虫（rs-reverse 方案，2026-08-15 攻克）

原理:
  1. curl_cffi (chrome110 TLS) 请求目标页 -> 412 + O cookie + $_ts(nsd/cd) + VM JS
  2. node rs-reverse makecookie (-f ts.json -j vm.js) 纯算法计算 P cookie (~1-2s)
     - ts.json 必须带 hasDebug:true (站点D 是 debugger 变体, hd 位实测 0x80)
     - len160 适配器 (patch_rs_reverse_site_d.py 注入, 真实 basearrEncrypt=160 实测)
  3. O+P 组合, 名字后缀 T/P 轮换验证 -> 200
  4. 首次请求偶发 412 (额外挑战轮) -> 会话自动吸收新 O-cookie 后重试

站点特性:
  - VM 变体轮换: 约 2/3 轮次任务执行崩 (变体 B), 换新挑战轮重试即过
  - cookie 名后缀 T/P 按轮次轮换
  - 首页与数据查询模块 cookie 族不同 (S/T vs O/P), 同 session 跨页正常

依赖:
  pip install curl_cffi
  npm install rs-reverse      # 在本目录执行
  python patch_rs_reverse_site_d.py   # 注入 len160 适配器 + Windows 双补丁

用法:
  python spider_rs_pure.py                      # 数据查询页
  python spider_rs_pure.py --url <URL>          # 指定页面
"""
import argparse
import base64
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from curl_cffi import requests

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SCRIPT_DIR = Path(__file__).parent
BASE_URL = base64.b64decode("aHR0cHM6Ly93d3cubm1wYS5nb3YuY24=").decode()
TARGET_URL = BASE_URL + "/datasearch/"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36")
BASEARR_KEY = "V1RJWBdeVk8XWlc="  # 站点D hostname -> len160 适配器


def resolve_main_js():
    r = subprocess.run(
        ["node", "-e", "console.log(require.resolve('rs-reverse'))"],
        capture_output=True, text=True, cwd=str(SCRIPT_DIR),
    )
    if r.returncode == 0 and r.stdout.strip():
        return r.stdout.strip()
    raise RuntimeError("未找到 rs-reverse 模块, 先 npm install rs-reverse")


def prep_round():
    """curl_cffi 拿 412 -> 同轮材料: ts.json(hasDebug) + vm.js + o_cookie.txt"""
    session = requests.Session()
    resp = session.get(TARGET_URL, headers={"User-Agent": UA},
                       impersonate="chrome110", timeout=15)
    if resp.status_code != 412:
        raise RuntimeError(f"Expected 412, got {resp.status_code}. 站点可能已升级或 IP 被限流")
    html = resp.text

    nsd = re.search(r"\$_ts\.nsd=(\d+)", html)
    cd = re.search(r"\$_ts\.cd=\"([^\"]*)\"", html)
    if not nsd or not cd:
        raise RuntimeError("412 页未找到 $_ts.nsd/cd")
    ts = {"nsd": int(nsd.group(1)), "cd": cd.group(1),
          "from": TARGET_URL, "hasDebug": True}
    (SCRIPT_DIR / "ts.json").write_text(
        json.dumps(ts, ensure_ascii=False), encoding="utf-8")

    o = "; ".join(f"{k}={v}" for k, v in session.cookies.items())
    (SCRIPT_DIR / "o_cookie.txt").write_text(o, encoding="utf-8")

    vm_path = re.search(r"<script[^>]*src=\"(/[^\"]+\.js)\"", html).group(1)
    vm = session.get(BASE_URL + vm_path,
                     headers={"User-Agent": UA, "Referer": TARGET_URL},
                     impersonate="chrome110", timeout=15).text
    (SCRIPT_DIR / "vm.js").write_text(vm, encoding="utf-8")
    return o, len(html), len(vm)


def makecookie(main_js):
    """rs-reverse 纯算法 -> P cookie (变体 B 轮次会崩, 返回 None)"""
    env = dict(os.environ, BASEARR_KEY=BASEARR_KEY)
    r = subprocess.run(
        ["node", main_js, "makecookie", "-f", "ts.json", "-j", "vm.js", "-l", "warn"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=120, cwd=str(SCRIPT_DIR), env=env,
    )
    out = r.stdout + r.stderr
    m = re.search(r"cookie值: (.*)", out)
    if "成功生成cookie" not in out or not m:
        errs = re.findall(r"ERROR rs-reverse -\S+ (.{0,60})", out)
        raise RuntimeError(f"makecookie 失败: {errs[:1] if errs else out[-300:]}")
    first = m.group(1).split(";")[0]
    name, val = first.split("=", 1)
    return name, val


def build_session(o_cookie, name, val):
    s = requests.Session()
    for part in (o_cookie + f";{name}={val}").split(";"):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            s.cookies.set(k.strip(), v.strip())
    return s


def get_session(max_rounds=8, verbose=True):
    """生产入口: 返回带有效 O+P cookie 的 curl_cffi Session"""
    main_js = resolve_main_js()
    for i in range(1, max_rounds + 1):
        try:
            o, html_len, vm_len = prep_round()
        except RuntimeError as e:
            raise
        try:
            name, val = makecookie(main_js)
        except RuntimeError as e:
            if verbose:
                print(f"[第{i}轮] VM 变体轮换: {e}, 重试新挑战轮")
            continue
        base = name[:-1]
        for suffix in ("T", "P"):
            s = build_session(o, base + suffix, val)
            r = None
            for attempt in range(3):  # 首次偶发 412 -> 会话吸收新 O 后重试
                try:
                    r = s.get(TARGET_URL, headers={"User-Agent": UA},
                              impersonate="chrome110", timeout=20)
                except Exception:
                    time.sleep(1)
                    continue
                if r.status_code == 200:
                    break
                time.sleep(1)
            if r is not None and r.status_code == 200:
                if verbose:
                    print(f"[第{i}轮] ✅ {base}{suffix} 通过 "
                          f"(P-cookie {len(val)} chars, 页面 {len(r.text)}b, 412页 {html_len}b, VM {vm_len}b)")
                return s
        if verbose:
            print(f"[第{i}轮] 生成成功但验证失败, 重试")
    raise RuntimeError(f"{max_rounds} 轮内未生成有效 cookie")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=TARGET_URL)
    args = ap.parse_args()

    print("=" * 60)
    print("rs-reverse 纯算法 — 站点D 瑞数")
    print("=" * 60)

    session = get_session()
    resp = session.get(args.url, headers={"User-Agent": UA},
                       impersonate="chrome110", timeout=20)
    m = re.search(r"<title>([^<]*)</title>", resp.text)
    print(f"\n[{resp.status_code}] {args.url}")
    print(f"标题: {m.group(1).strip() if m else '?'}, 大小: {len(resp.text)}b")
    out = SCRIPT_DIR / "site_d_200.html"
    out.write_text(resp.text, encoding="utf-8")
    print(f"已保存: {out}")
