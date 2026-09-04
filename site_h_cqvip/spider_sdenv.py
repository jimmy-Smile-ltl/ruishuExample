"""
spider_sdenv.py — 维普期刊 (CQVIP) 瑞数6 sdenv 链式方案

链路: curl_cffi(chrome110) 抓 412 挑战页 + O-cookie
  → node generate_cookie.js (sdenv jsdomFromText 本地执行 VM) 生成 P-cookie
  → 组合 O+P 下一轮 → 200

模板来源: ruishuExample/patent_cnipa (2026-08-19 实测通过)。

依赖: pip install curl_cffi ; sdenv 已装在 spider research 根 node_modules
  (generate_cookie.js 通过 SDENV_DIR 环境变量定位)
用法: python spider_sdenv.py [--rounds=3]
"""
import os
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
# sdenv npm 包: 向上递归找 node_modules/sdenv → 环境变量 SDENV_DIR
# (本机 sdenv 装在 spider research 根 node_modules; npm 只在根目录安装)
def _find_sdenv():
    for p in [PROJ] + list(PROJ.parents):
        cand = p / "node_modules" / "sdenv" / "package.json"
        if cand.exists():
            return p / "node_modules"
    env = os.environ.get("SDENV_DIR")
    if env and (Path(env) / "sdenv" / "package.json").exists():
        return Path(env)
    return None

SDENV_DIR = _find_sdenv()
# 目标 URL (base64, 运行时解码)
BASE = base64.b64decode("aHR0cHM6Ly9xaWthbi5jcXZpcC5jb20=").decode()
TARGET = base64.b64decode(
    "aHR0cHM6Ly9xaWthbi5jcXZpcC5jb20vUWlrYW4vSm91cm5hbC9Kb3VybmFsR3VpZD9mcm9tPWluZGV4").decode()
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36")
VM_WAIT = 14  # VM 生成 cookie 的最长等待秒数


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def run_vm(html: str, url: str) -> str:
    """本地 sdenv jsdomFromText 执行 412 挑战页, 返回 document.cookie (P-cookie)"""
    if SDENV_DIR is None:
        raise RuntimeError("找不到 sdenv: 先 npm i sdenv 或设置 SDENV_DIR")
    with tempfile.NamedTemporaryFile('w', suffix='.html', delete=False,
                                     encoding='utf-8') as f:
        f.write(html)
        tmp = f.name
    try:
        env = dict(os.environ)
        env["SDENV_DIR"] = str(SDENV_DIR)
        res = subprocess.run(
            ["node", "generate_cookie.js", tmp, url, str(VM_WAIT)],
            cwd=str(PROJ), capture_output=True, text=True,
            timeout=VM_WAIT + 60, encoding='utf-8', errors='replace', env=env)
    finally:
        Path(tmp).unlink(missing_ok=True)
    for line in res.stderr.splitlines():
        if any(k in line for k in ("RESULT", "BLOCKED", "FATAL")):
            log(f"  [vm] {line.split('] ', 1)[-1] if '] ' in line else line.strip()}")
    return res.stdout.strip()


def set_cookies(session, cookie_str):
    for p in cookie_str.split(";"):
        p = p.strip()
        if "=" in p:
            k, v = p.split("=", 1)
            session.cookies.set(k.strip(), v.strip())


def chain_get(session, url, max_rounds=3):
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
    ap = argparse.ArgumentParser(description="sdenv 链式方案验证 (412 → VM → 200)")
    ap.add_argument("--rounds", type=int, default=3)
    args = ap.parse_args()

    print("=" * 70)
    print(f"sdenv 链式方案验证: {TARGET}")
    print(f"sdenv 路径: {SDENV_DIR}")
    print("=" * 70)

    s = req.Session()
    t0 = time.time()
    r = chain_get(s, TARGET, args.rounds)
    elapsed = time.time() - t0

    if r is not None and r.status_code == 200:
        m = re.search(r'<title>([^<]*)</title>', r.text)
        print(f"\n  ✅ {TARGET} 200  {len(r.text)}b  "
              f"{m.group(1).strip() if m else ''}  ({elapsed:.1f}s)")
        print(f"  cookies: {dict(s.cookies)}")
        (PROJ / "output").mkdir(exist_ok=True)
        (PROJ / "output" / "sdenv_page_200.html").write_text(r.text, encoding="utf-8")
        print(f"  页面已保存 → output/sdenv_page_200.html")
    else:
        print(f"\n  ❌ {r.status_code if r else 'None'}  ({elapsed:.1f}s)")
        print("  提示: 连续失败可能被 IP 限流, 等 1-3 小时或换代理重试")

    print("\n" + "=" * 70)
    print(f"结论: {'PASS' if (r and r.status_code == 200) else 'FAIL'}")
    print("=" * 70)


if __name__ == "__main__":
    main()
