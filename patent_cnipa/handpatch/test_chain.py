"""
手写补环境链式验证 — 专利局双站

流程:
  curl_cffi 拿挑战页 (412/202) + O-cookie
    → node run_vm.js (手写环境跑 VM) → P-cookie
    → 组合 O+P 重放 → 200?

用法:
    python test_chain.py pro38
    python test_chain.py pro39
    python test_chain.py pro38 --debug
"""
import re
import sys
import json
import time
import base64
import subprocess
import tempfile
import argparse
from pathlib import Path
import curl_cffi.requests as req

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

PROJ = Path(__file__).parent
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36")

# 目标 URL (base64, 运行时解码)
SITES = {
    "pro38": {"url": base64.b64decode(
        "aHR0cHM6Ly9wc3Mtc3lzdGVtLmNwb25saW5lLmNuaXBhLmdvdi5jbi9jb252ZW50aW9uYWxTZWFyY2g=").decode()},
    "pro39": {"url": base64.b64decode(
        "aHR0cDovL2VwdWIuY25pcGEuZ292LmNuLw==").decode()},
}


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def is_challenge(r) -> bool:
    return r.status_code in (202, 412) or (
        r.status_code == 200 and '$_ts' in r.text[:2000] and len(r.text) < 5000)


def run_vm(html_text: str, url: str, debug: bool, wait: int = 8) -> str:
    with tempfile.NamedTemporaryFile('w', suffix='.html', delete=False,
                                     encoding='utf-8') as f:
        f.write(html_text)
        tmp = f.name
    try:
        cmd = ["node", "run_vm.js", tmp, url, "--wait", str(wait)]
        if debug:
            cmd.append("--debug")
        res = subprocess.run(cmd, cwd=str(PROJ), capture_output=True, text=True,
                             timeout=wait + 40)
    finally:
        Path(tmp).unlink(missing_ok=True)
    for line in res.stderr.splitlines():
        if any(k in line for k in ("nsd=", "RESULT", "FATAL", "Trigger", "VM ", "BLOCKED")):
            log(f"  {line.split('] ', 1)[-1] if '] ' in line else line.strip()}")
    return res.stdout.strip()


def set_cookies(session, cookie_str):
    for p in cookie_str.split(";"):
        p = p.strip()
        if "=" in p:
            k, v = p.split("=", 1)
            session.cookies.set(k.strip(), v.strip())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("site", choices=list(SITES))
    ap.add_argument("--debug", action="store_true")
    ap.add_argument("--wait", type=int, default=8)
    args = ap.parse_args()

    url = SITES[args.site]["url"]
    print("=" * 70)
    print(f"手写补环境链式验证 — {args.site} {url}")
    print("=" * 70)

    s = req.Session()
    for rnd in range(1, 4):
        r = s.get(url, headers={"User-Agent": UA}, impersonate="chrome110", timeout=20)
        log(f"round {rnd}: {r.status_code} len={len(r.text)} "
            f"(cookies: {len(dict(s.cookies))})")
        if not is_challenge(r):
            break
        p_cookie = run_vm(r.text, url, args.debug, args.wait)
        if not p_cookie:
            log("[FAIL] VM 未产出 P-cookie")
            return
        set_cookies(s, p_cookie)

    r = s.get(url, headers={"User-Agent": UA}, impersonate="chrome110", timeout=20)
    ok = r.status_code == 200 and not is_challenge(r)
    print("\n" + "=" * 70)
    if ok:
        m = re.search(r'<title>([^<]*)</title>', r.text)
        print(f"✅ {args.site} 手写补环境通过! {r.status_code} {len(r.text)}b "
              f"{m.group(1) if m else ''}")
    else:
        print(f"❌ {args.site} 未通过: {r.status_code} len={len(r.text)}")
    print("=" * 70)


if __name__ == "__main__":
    main()
