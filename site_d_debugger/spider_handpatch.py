"""
方案 4: 手写 harness + browser() 补丁直调 — 站点D 瑞数

架构 (2026-08-15 攻克, 脱离 sdenv 的 jsdomFromText 流程):
  curl_cffi (chrome110) 负责所有 HTTP
    ├─ GET → 412 + O-cookie → 保存 412 HTML + VM 文件
    ├─ node build_env_browser.js (JSDOM + browser(w,'chrome') 直调) → P-cookie
    └─ O+P 组合 → 重新请求 → 200

关键配方 (三轮探索):
  - runScripts 'dangerously' + resources 'usable' (VM 在 parse 阶段执行)
  - browser(w,'chrome') + getHandle('window')({}) (补丁层 + 代理 realm)
  - ★ VirtualConsole 吞 jsdomError (泄漏错误会污染 VM 流程 + 写入 cookie jar → 400)
  - cookieJar + userAgent + pretendToBeVisual + redirect 拦截

用法:
    python spider_handpatch.py                 # 首页 + /datasearch/ + 搜索结果
    python spider_handpatch.py --url <URL>     # 单 URL
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
VM_WAIT = 12
EXECUTOR = PROJ / 'build_env_browser.js'


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def run_vm(session, html: str, url: str, tag: str) -> str:
    """下载 VM + 本地执行 (build_env_browser.js), 返回 document.cookie"""
    m = re.search(r'<script[^>]+src="([^"]+\.js)"', html)
    vm_name = m.group(1).split('/').pop() if m else 'vm.js'
    vm_url = (m.group(1) if m and m.group(1).startswith('http') else BASE + m.group(1))
    vr = session.get(vm_url, headers={"User-Agent": UA, "Referer": url},
                     impersonate="chrome110", timeout=20)

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        (tmp / '412.html').write_text(html, encoding='utf-8')
        (tmp / vm_name).write_text(vr.text, encoding='utf-8')
        res = subprocess.run(
            ["node", str(EXECUTOR), str(tmp / '412.html'), url, str(VM_WAIT)],
            cwd=str(PROJ), capture_output=True, text=True, timeout=VM_WAIT + 40)
    for line in res.stderr.splitlines():
        if any(k in line for k in ("RESULT", "BLOCKED", "FATAL")):
            log(f"  [{tag}] {line.split('] ', 1)[-1] if '] ' in line else line.strip()}")
    # stdout 可能混入 noise, 只取真实 P-cookie 段
    raw = res.stdout
    for prefix in ('NfBCSins2OywT=', 'NfBCSins2OywP='):
        if prefix in raw:
            return raw[raw.find(prefix):].strip()
    return raw.strip()


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
        p_cookie = run_vm(session, r.text, url, f"round{rnd}")
        if not p_cookie:
            log("  [FAIL] VM 未产出 P-cookie")
            return None
        set_cookies(session, p_cookie)
    r = session.get(url, headers={"User-Agent": UA, "Referer": BASE + "/"},
                    impersonate="chrome110", timeout=20)
    log(f"  final: {r.status_code} len={len(r.text)}")
    return r


def check(url, session=None):
    session = session or req.Session()
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
    print("方案 4: 手写 harness + browser() 直调 — 站点D 瑞数")
    print("=" * 70)

    if args.url:
        check(args.url)
        return

    print("\n── 首页")
    home_ok, _ = check(BASE + "/")

    print("\n── /datasearch/")
    ds_ok, session = check(BASE + "/datasearch/")

    print("\n── search-result.html (复用会话)")
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
