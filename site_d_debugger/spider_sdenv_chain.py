"""
sdenv 链式补环境 — 瑞数多阶段挑战 (站点D 示例)

架构 (2026-08-13 基于两轮 412 诊断):
  curl_cffi (chrome110) 负责所有 HTTP (TLS 一致)
    ├─ GET → 412 + O-cookie → 保存 412 HTML
    ├─ node stage_vm.js (jsdomFromText 本地跑 VM) → P-cookie
    └─ 组合 O+P 下一轮, 直到 200 (最多 3 轮)

依赖:
  pip install curl_cffi
  npm install        # 在本目录 (sdenv, 需 node-gyp + VS C++ 编译环境)

用法:
    python spider_sdenv_chain.py                 # 默认: 首页 + /datasearch/ + 搜索结果页
    python spider_sdenv_chain.py --url <URL>     # 单 URL 验证
"""
import argparse
import base64
import re
import sys
import time
import subprocess
import tempfile
from pathlib import Path
import curl_cffi.requests as req

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

PROJ = Path(__file__).parent
BASE = base64.b64decode("aHR0cHM6Ly93d3cubm1wYS5nb3YuY24=").decode()
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36")
VM_WAIT = 10


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def run_vm(html: str, url: str, tag: str) -> str:
    """本地 jsdomFromText 执行 VM, 返回 document.cookie"""
    with tempfile.NamedTemporaryFile('w', suffix='.html', delete=False,
                                     encoding='utf-8') as f:
        f.write(html)
        tmp = f.name
    try:
        res = subprocess.run(
            ["node", "stage_vm.js", tmp, url, str(VM_WAIT)],
            cwd=str(PROJ), capture_output=True, text=True, timeout=VM_WAIT + 40)
    finally:
        Path(tmp).unlink(missing_ok=True)
    for line in res.stderr.splitlines():
        if any(k in line for k in ("RESULT", "BLOCKED", "FATAL", "html=")):
            log(f"  [{tag}] {line.split('] ', 1)[-1] if '] ' in line else line.strip()}")
    return res.stdout.strip()


def set_cookies(session, cookie_str):
    for p in cookie_str.split(";"):
        p = p.strip()
        if "=" in p:
            k, v = p.split("=", 1)
            session.cookies.set(k.strip(), v.strip())


def chain_get(session, url, max_rounds=3):
    """链式: 412 → VM → 组合 cookie → 下一轮, 直到非 412"""
    for rnd in range(1, max_rounds + 1):
        r = session.get(url, headers={"User-Agent": UA, "Referer": BASE + "/"},
                        impersonate="chrome110", timeout=20)
        log(f"  round {rnd}: {r.status_code} len={len(r.text)} "
            f"(session cookies: {len(dict(session.cookies))})")
        if r.status_code != 412:
            return r
        p_cookie = run_vm(r.text, url, f"round{rnd}")
        if not p_cookie:
            log("  [FAIL] VM 未产出 P-cookie")
            return None
        set_cookies(session, p_cookie)
    r = session.get(url, headers={"User-Agent": UA, "Referer": BASE + "/"},
                    impersonate="chrome110", timeout=20)
    log(f"  final: {r.status_code} len={len(r.text)}")
    return r


def check(url):
    """单 URL 链式验证"""
    session = req.Session()
    t0 = time.time()
    r = chain_get(session, url)
    elapsed = time.time() - t0
    if r is not None and r.status_code == 200:
        m = re.search(r'<title>([^<]*)</title>', r.text)
        print(f"  ✅ 200  {len(r.text)}b  {m.group(1).strip() if m else ''}  ({elapsed:.1f}s)")
        return True, session
    print(f"  ❌ {r.status_code if r else 'None'}  ({elapsed:.1f}s)")
    return False, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default=None)
    args = ap.parse_args()

    print("=" * 70)
    print("sdenv 链式补环境 — 瑞数多阶段挑战 (站点D)")
    print("=" * 70)

    if args.url:
        check(args.url)
        return

    # ── 1. 首页 (验证 jsdomFromText VM 层) ──────────────────────
    print("\n── 首页")
    home_ok, _ = check(BASE + "/")

    # ── 2. /datasearch/ (链式) ──────────────────────────────────
    print("\n── /datasearch/")
    ds_ok, session = check(BASE + "/datasearch/")

    # ── 3. search-result.html (复用会话) ────────────────────────
    print("\n── search-result.html (复用最终会话)")
    r3 = None
    if ds_ok:
        t0 = time.time()
        r3 = chain_get(session, BASE + "/datasearch/search-result.html")
        if r3 is not None and r3.status_code == 200:
            print(f"  ✅ 200  {len(r3.text)}b  ({time.time() - t0:.1f}s)")
        else:
            print(f"  ❌ {r3.status_code if r3 else 'None'}")

    print("\n" + "=" * 70)
    print(f"结论: 首页={'PASS' if home_ok else 'FAIL'}  "
          f"数据查询={'PASS' if ds_ok else 'FAIL'}  "
          f"搜索结果={'PASS' if (r3 and r3.status_code == 200) else 'FAIL'}")
    print("=" * 70)


if __name__ == "__main__":
    main()
