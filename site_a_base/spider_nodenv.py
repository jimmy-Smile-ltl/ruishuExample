"""
spider_nodenv.py — 站点A（高校组）瑞数6 零依赖手写补环境链式方案

移植自 patent_cnipa/nodenv 9/9 打通方案（2026-09-02 三校实测 15/15）。

链路: curl_cffi(chrome110) 抓 412 挑战页 + O-cookie
  → node nodenv/run_vm.js (手写 Node vm 沙箱, 零 npm 依赖) 生成 P-cookie
  → 组合 O+P 下一轮 → 200

★ 实测通过 (2026-09-02): 高校3(bupt) 5/5 (13.4-13.6s, T=250c) /
  高校4(njnu) 5/5 (13.7-14.3s, T=250c) / 高校1(lzu) 5/5 (14.0-14.4s, P=335c)
★ 与 sdenv 补环境同为"无浏览器部署"档, 但零 npm 依赖 (不需要 sdenv/VS Build Tools)

依赖: pip install curl_cffi (node 侧零依赖)
用法: python spider_nodenv.py --site lzu|bupt|njnu [--rounds=3]
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
# 实测覆盖三校 (2026-09-02 15/15); scu/njust 为独立锁定模板 (pro36/handpatch_v3 runner),
# njust 是 meta-embedded 特殊形态 nodenv 暂未适配
SITES = {
    "lzu": base64.b64decode("aHR0cHM6Ly93d3cubHp1LmVkdS5jbg==").decode() + "/",
    "bupt": base64.b64decode("aHR0cHM6Ly93d3cuYnVwdC5lZHUuY24=").decode() + "/",
    "njnu": base64.b64decode("aHR0cHM6Ly93d3cubmpudS5lZHUuY24=").decode() + "/",
}
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36")
VM_WAIT = 16


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
        if any(k in line for k in ("RESULT", "BLOCKED", "FATAL", "RIC-ERR", "ERR")):
            log(f"  [{tag}] {line.split('] ', 1)[-1] if '] ' in line else line.strip()[:130]}")
    return res.stdout.strip()


def set_cookies(session, cookie_str):
    for p in cookie_str.split(";"):
        p = p.strip()
        if "=" in p:
            k, v = p.split("=", 1)
            session.cookies.set(k.strip(), v.strip())


def chain_get(session, url, max_rounds=3):
    for rnd in range(1, max_rounds + 1):
        r = session.get(url, headers={"User-Agent": UA, "Referer": url},
                        impersonate="chrome110", timeout=20)
        log(f"  round {rnd}: {r.status_code} len={len(r.text)} "
            f"(session cookies: {list(dict(session.cookies))})")
        if r.status_code != 412:
            return r
        p_cookie = run_vm(r.text, url, f"round{rnd}")
        if not p_cookie:
            log("  [FAIL] VM 未产出 cookie")
            return None
        log(f"  VM cookie: {p_cookie[:80]}...")
        set_cookies(session, p_cookie)
    r = session.get(url, headers={"User-Agent": UA, "Referer": url},
                    impersonate="chrome110", timeout=20)
    log(f"  final: {r.status_code} len={len(r.text)}")
    return r


def main():
    ap = argparse.ArgumentParser(description="站点A nodenv 零依赖补环境链式 (412 → VM → 200)")
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--site", default="bupt", choices=list(SITES))
    args = ap.parse_args()
    TARGET = SITES[args.site]

    print("=" * 70)
    print(f"nodenv 零依赖补环境链式验证 — {args.site} {TARGET}")
    print("=" * 70)
    s = req.Session()
    t0 = time.time()
    r = chain_get(s, TARGET, args.rounds)
    elapsed = time.time() - t0
    if r is not None and r.status_code == 200:
        m = re.search(r'<title>([^<]*)</title>', r.text)
        print(f"\n  ✅ {args.site} 200  {len(r.text)}b  "
              f"{m.group(1).strip() if m else ''}  ({elapsed:.1f}s)")
        print(f"  cookies: {dict(s.cookies)}")
    else:
        print(f"\n  ❌ {r.status_code if r else 'None'}  ({elapsed:.1f}s)")
    print("=" * 70)


if __name__ == "__main__":
    main()
