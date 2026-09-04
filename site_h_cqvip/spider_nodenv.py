"""
spider_nodenv.py — 维普期刊 (CQVIP) 瑞数6 零依赖补环境链式方案

链路: curl_cffi(chrome110) 抓 412 挑战页 + O-cookie
  → node nodenv/run_vm.js (手写 Node vm 沙箱, 零 npm 依赖) 生成 P-cookie
  → 组合 O+P 下一轮 → 200

模板来源: ruishuExample/patent_cnipa/nodenv 九件套 (2026-09-01 专利局 9/9 实测),
  挑战形态一致 (nsd/cd 内联 + r='m' meta + 外部 VM js)。

依赖: pip install curl_cffi (node 侧零依赖, 不需要 sdenv)
用法: python spider_nodenv.py [--rounds=3]
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
NODENV = PROJ / "nodenv"
# 目标: 维普期刊导航页 (base64, 运行时解码)
BASE = base64.b64decode("aHR0cHM6Ly9xaWthbi5jcXZpcC5jb20=").decode()
TARGET = base64.b64decode(
    "aHR0cHM6Ly9xaWthbi5jcXZpcC5jb20vUWlrYW4vSm91cm5hbC9Kb3VybmFsR3VpZD9mcm9tPWluZGV4").decode()
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36")
VM_WAIT = 16  # VM 生成 cookie 的最长等待秒数


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def run_vm(html: str, url: str, tag: str) -> str:
    """本地手写 vm 沙箱执行 412 挑战页, 返回 document.cookie (P-cookie)"""
    with tempfile.NamedTemporaryFile('w', suffix='.html', delete=False,
                                     encoding='utf-8') as f:
        f.write(html)
        tmp = f.name
    try:
        res = subprocess.run(
            ["node", "run_vm.js", tmp, url, "--wait", str(VM_WAIT), "--no-instrument"],
            cwd=str(NODENV), capture_output=True, text=True,
            timeout=VM_WAIT + 90, encoding='utf-8', errors='replace')
    finally:
        Path(tmp).unlink(missing_ok=True)
    for line in res.stderr.splitlines():
        if any(k in line for k in ("RESULT", "BLOCKED", "FATAL", "html=", "RIC-ERR", "Trigger")):
            log(f"  [{tag}] {line.split('] ', 1)[-1] if '] ' in line else line.strip()[:120]}")
    return res.stdout.strip()


def set_cookies(session, cookie_str):
    for p in cookie_str.split(";"):
        p = p.strip()
        if "=" in p:
            k, v = p.split("=", 1)
            session.cookies.set(k.strip(), v.strip())


def chain_get(session, url, max_rounds=3):
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


def main():
    ap = argparse.ArgumentParser(description="nodenv 零依赖补环境链式 (412 → VM → 200)")
    ap.add_argument("--rounds", type=int, default=3)
    args = ap.parse_args()

    print("=" * 70)
    print("nodenv 零依赖补环境链式验证 — 维普期刊 JournalGuid")
    print("=" * 70)
    s = req.Session()
    t0 = time.time()
    r = chain_get(s, TARGET, args.rounds)
    elapsed = time.time() - t0
    if r is not None and r.status_code == 200:
        m = re.search(r'<title>([^<]*)</title>', r.text)
        print(f"\n  ✅ JournalGuid 200  {len(r.text)}b  "
              f"{m.group(1).strip() if m else ''}  ({elapsed:.1f}s)")
        print(f"  cookies: {dict(s.cookies)}")
        out = PROJ / "output"
        out.mkdir(exist_ok=True)
        (out / "nodenv_page_200.html").write_text(r.text, encoding="utf-8")
        print(f"  页面已保存 → output/nodenv_page_200.html")
    else:
        print(f"\n  ❌ {r.status_code if r else 'None'}  ({elapsed:.1f}s)")
    print("=" * 70)


if __name__ == "__main__":
    main()
