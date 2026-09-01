"""
spider_nodenv.py — 专利检索系统 (CNIPA) 瑞数6 零依赖补环境链式方案（最简可行版）

链路: curl_cffi(chrome110) 抓 412 挑战页 + O-cookie
  → node nodenv/run_vm.js (手写 Node vm 沙箱, 零 npm 依赖) 生成 P-cookie
  → 组合 O+P 下一轮 → 200

★ 实测通过 (2026-09-01): round1=412(2509b) → VM 12.0s → round2=200(8059-8209b),
  共 13.4-13.8s, 9/9 全过。

根因史 (供后来者):
  - 2026-08-19: 357 chars cookie 恒 400 — 8 处环境差异 (window/document/navigator 键集等)
  - 2026-08-31: 8 处修复后变 0 chars — 新问题是 env.js cookie setter 用宿主真实
    Date.now 误判 VM fixdate 的 expires 为过期 → 主 cookie 写完即删
  - 2026-09-01: setter 过期判断基准对齐 VM 时间源 (fixDateMs) → 200 终局
    教训: env 宿主侧与 VM 沙箱侧的时间源必须一致

依赖: pip install curl_cffi (node 侧零依赖, 不需要 sdenv)
用法: python spider_nodenv.py [--url=...] [--rounds=3]
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
# 目标 URL (base64, 运行时解码; 实名映射见仓库根 sites_mapping.local.md)
BASE = base64.b64decode(
    "aHR0cHM6Ly9wc3Mtc3lzdGVtLmNwb25saW5lLmNuaXBhLmdvdi5jbg==").decode()
TARGET = base64.b64decode(
    "aHR0cHM6Ly9wc3Mtc3lzdGVtLmNwb25saW5lLmNuaXBhLmdvdi5jbi9jb252ZW50aW9uYWxTZWFyY2g=").decode()
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36")
VM_WAIT = 16  # VM 生成 cookie 的最长等待秒数 (实测 ~12s)


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
        if any(k in line for k in ("RESULT", "BLOCKED", "FATAL", "html=", "RIC-ERR")):
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
    print("nodenv 零依赖补环境链式验证 — 专利检索系统 conventionalSearch")
    print("=" * 70)
    s = req.Session()
    t0 = time.time()
    r = chain_get(s, TARGET, args.rounds)
    elapsed = time.time() - t0
    if r is not None and r.status_code == 200:
        m = re.search(r'<title>([^<]*)</title>', r.text)
        print(f"\n  ✅ conventionalSearch 200  {len(r.text)}b  "
              f"{m.group(1).strip() if m else ''}  ({elapsed:.1f}s)")
        print(f"  cookies: {dict(s.cookies)}")
    else:
        print(f"\n  ❌ {r.status_code if r else 'None'}  ({elapsed:.1f}s)")
    print("=" * 70)


if __name__ == "__main__":
    main()
