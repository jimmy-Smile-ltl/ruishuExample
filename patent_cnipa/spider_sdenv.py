"""
spider_sdenv.py — 专利检索系统 (CNIPA) 瑞数6 sdenv 链式方案（最简可行版）

链路: curl_cffi(chrome110) 抓 412 挑战页 + O-cookie
  → node generate_cookie.js (jsdomFromText 本地执行 VM) 生成 P-cookie
  → 组合 O+P 下一轮 → 200

★ 实测通过 (2026-08-19 23:28): round1=412(2480b) → VM 6.2s → round2=200(8057b), 共 9.9s
★ 已证不可行: 手写 Node vm 补环境 (nodenv) 同形状 357 chars cookie 恒 400 — 差异在
  VM 深栈运行时对象, 补环境无法对齐; sdenv-jsdom 是此站点唯一可行的纯 Node 路线。

依赖: pip install curl_cffi ; node generate_cookie.js 依赖 npm i sdenv
用法: python spider_sdenv.py [--url=...] [--rounds=3]
"""
import sys
import time
import re
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
BASE = base64.b64decode(
    "aHR0cHM6Ly9wc3Mtc3lzdGVtLmNwb25saW5lLmNuaXBhLmdvdi5jbg==").decode()
TARGET = base64.b64decode(
    "aHR0cHM6Ly9wc3Mtc3lzdGVtLmNwb25saW5lLmNuaXBhLmdvdi5jbi9jb252ZW50aW9uYWxTZWFyY2g=").decode()
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36")
VM_WAIT = 10  # VM 生成 cookie 的最长等待秒数


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def run_vm(html: str, url: str) -> str:
    """本地 jsdomFromText 执行 412 挑战页, 返回 document.cookie (P-cookie)"""
    with tempfile.NamedTemporaryFile('w', suffix='.html', delete=False,
                                     encoding='utf-8') as f:
        f.write(html)
        tmp = f.name
    try:
        res = subprocess.run(
            ["node", "generate_cookie.js", tmp, url, str(VM_WAIT)],
            cwd=str(PROJ), capture_output=True, text=True, timeout=VM_WAIT + 40)
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


def chain_get(session, url, max_rounds=3) -> int:
    """链式: 412 → VM 生成 P → 组合 cookie → 下一轮, 直到非 412"""
    for rnd in range(1, max_rounds + 1):
        r = session.get(url, headers={"User-Agent": UA, "Referer": BASE + "/"},
                        impersonate="chrome110", timeout=20)
        log(f"  round {rnd}: {r.status_code} len={len(r.text)} "
            f"(session cookies: {len(dict(session.cookies))})")
        if r.status_code != 412:
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
    print(f"sdenv 链式方案验证: {args.url}")
    print("=" * 70)

    s = req.Session()
    t0 = time.time()
    r = chain_get(s, args.url, args.rounds)
    elapsed = time.time() - t0

    if r is not None and r.status_code == 200:
        m = re.search(r'<title>([^<]*)</title>', r.text)
        print(f"\n  ✅ {args.url} 200  {len(r.text)}b  "
              f"{m.group(1).strip() if m else ''}  ({elapsed:.1f}s)")
        print(f"  cookies: {dict(s.cookies)}")
        (PROJ / "output").mkdir(exist_ok=True)
        (PROJ / "output" / "page_200.html").write_text(r.text, encoding="utf-8")
        print(f"  页面已保存 → output/page_200.html")
    else:
        print(f"\n  ❌ {r.status_code if r else 'None'}  ({elapsed:.1f}s)")
        print("  提示: 连续失败可能被 IP 限流, 等 1-3 小时或换代理重试")

    print("\n" + "=" * 70)
    print(f"结论: {'PASS' if (r and r.status_code == 200) else 'FAIL'}")
    print("=" * 70)


if __name__ == "__main__":
    main()
