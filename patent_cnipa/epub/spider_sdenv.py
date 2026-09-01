"""
spider_sdenv.py — 专利公布公告 sdenv 链式方案（202 挑战变体）

链路: curl_cffi(chrome110) 抓 202 挑战页 + O-cookie
  → node ../generate_cookie.js (jsdomFromText 本地执行 VM) 生成 P-cookie
  → 组合 O+P 下一轮 → 200

与检索站 (父目录) 同架构, 差异: 挑战页状态码是 202 (非 412),
且 200 页面小于 5000b 且含 $_ts 也算挑战页 (真实页面头部常内嵌 $_ts 刷新块)。

★ 实测通过 (2026-08-15): 首页 202 → VM 出 P-cookie (285 chars, ~5s) → 200。
★ 局限: /Dxb/PageQuery 翻页 AJAX 需要瑞数动态 token (页面 XHR hook 自动附加),
  纯 curl 无 token → 400。翻页爬取用同目录 rpc_spider.py (CDP RPC 生产方案)。

依赖: pip install curl_cffi ; 父目录 generate_cookie.js 依赖 npm i sdenv
用法: python spider_sdenv.py
"""
import re
import sys
import json
import time
import base64
import argparse
import subprocess
import tempfile
from pathlib import Path
import curl_cffi.requests as req

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

PROJ = Path(__file__).parent
# 目标 URL (base64, 运行时解码)
BASE = base64.b64decode("aHR0cDovL2VwdWIuY25pcGEuZ292LmNu").decode()
TARGET = BASE + "/"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36")
VM_WAIT = 10  # VM 生成 cookie 的最长等待秒数


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def is_challenge(r) -> bool:
    """判断是否为瑞数挑战页 (202/412 且含 $_ts; 200 小页面含 $_ts 也算)"""
    return r.status_code in (202, 412) or (
        r.status_code == 200 and '$_ts' in r.text[:2000] and len(r.text) < 5000)


def run_vm(html: str, url: str) -> str:
    """本地 jsdomFromText 执行挑战页, 返回 document.cookie (P-cookie)"""
    with tempfile.NamedTemporaryFile('w', suffix='.html', delete=False,
                                     encoding='utf-8') as f:
        f.write(html)
        tmp = f.name
    try:
        res = subprocess.run(
            ["node", str(PROJ.parent / "generate_cookie.js"), tmp, url, str(VM_WAIT)],
            cwd=str(PROJ.parent), capture_output=True, text=True, timeout=VM_WAIT + 40)
        for line in res.stderr.splitlines():
            if any(k in line for k in ("RESULT", "BLOCKED", "FATAL")):
                log(f"  [vm] {line.split('] ', 1)[-1] if '] ' in line else line.strip()}")
    finally:
        Path(tmp).unlink(missing_ok=True)
    return res.stdout.strip()


def set_cookies(session, cookie_str):
    for p in cookie_str.split(";"):
        p = p.strip()
        if "=" in p:
            k, v = p.split("=", 1)
            session.cookies.set(k.strip(), v.strip())


def chain_get(session, url, max_rounds=3):
    """链式: 挑战页 → VM 生成 P → 组合 cookie → 下一轮, 直到 200"""
    for rnd in range(1, max_rounds + 1):
        r = session.get(url, headers={"User-Agent": UA, "Referer": BASE + "/"},
                        impersonate="chrome110", timeout=20)
        log(f"  round {rnd}: {r.status_code} len={len(r.text)} "
            f"(session cookies: {len(dict(session.cookies))})")
        if not is_challenge(r):
            return r
        p_cookie = run_vm(r.text, url)
        if not p_cookie:
            log("  [FAIL] VM 未产出 P-cookie")
            return None
        set_cookies(session, p_cookie)
    r = session.get(url, headers={"User-Agent": UA, "Referer": BASE + "/"},
                    impersonate="chrome110", timeout=20)
    log(f"  final: {r.status_code} len={len(r.text)}")
    return r


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default=TARGET)
    p.add_argument("--rounds", type=int, default=3)
    args = p.parse_args()

    print("=" * 70)
    print("sdenv 链式方案验证: 专利公布公告 (202 挑战变体)")
    print("=" * 70)

    s = req.Session()
    t0 = time.time()
    r = chain_get(s, args.url, args.rounds)
    elapsed = time.time() - t0

    if r is not None and r.status_code == 200 and not is_challenge(r):
        m = re.search(r'<title>([^<]*)</title>', r.text)
        print(f"\n  ✅ 首页 200  {len(r.text)}b  {m.group(1).strip() if m else ''}  ({elapsed:.1f}s)")
        print(f"  cookies ({len(dict(s.cookies))} 个):")
        for k, v in dict(s.cookies).items():
            print(f"    {k} = {v[:40]}{'...' if len(v) > 40 else ''}")
        (PROJ / "output").mkdir(exist_ok=True)
        (PROJ / "output" / "page_200.html").write_text(r.text, encoding="utf-8")
        (PROJ / "output" / "cookies.txt").write_text(
            json.dumps(dict(s.cookies), indent=2), encoding="utf-8")
        print(f"  页面已保存 → output/page_200.html")
    else:
        print(f"\n  ❌ {r.status_code if r else 'None'}  ({elapsed:.1f}s)")
        print("  提示: 连续失败可能被 IP 限流, 等 1-3 小时或换代理重试")

    print("\n" + "=" * 70)
    print(f"结论: {'PASS' if (r and r.status_code == 200 and not is_challenge(r)) else 'FAIL'}")
    print("=" * 70)


if __name__ == "__main__":
    main()
