# -*- coding: utf-8 -*-
"""
站点F（税务局，TLS 指纹双变体版）— 手写补环境备用方案（纯 Node，零 npm 依赖）

实测: 2026-08-16, 5/5 轮 200, 2.2-3.0s/次
环境模板 browser_envs_v3.js 移植自站点C（医院 v6/v7，20/20 轮验证）:
  setFuncNative 原生伪装层 (37+ 函数) + 异步 timer + try/catch + VM 执行期隐藏 process/global

用法: python spider_manual_env.py
"""
import base64
import re
import subprocess
import sys
import time
from pathlib import Path

from curl_cffi import requests

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).parent
# 目标 URL (base64, 运行时解码)
TARGET = base64.b64decode(
    "aHR0cHM6Ly9ldGF4LnRpYW5qaW4uY2hpbmF0YXguZ292LmNuOjg0NDMv").decode()
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
ENV_TEMPLATE = HERE / "browser_envs_v3.js"
WAIT_MS = 1500
MAX_REGENS = 5


def generate_cookies(session):
    """412 → O-cookie; Node v3 补环境执行 VM → P-cookie"""
    resp = session.get(TARGET, headers={"User-Agent": UA},
                       impersonate="chrome110", timeout=20, verify=False)
    if resp.status_code != 412:
        raise RuntimeError(f"Expected 412, got {resp.status_code}")
    html = resp.text
    meta = re.search(r'<meta[^>]*r=[\'"]m[\'"][^>]*>', html)
    script = re.search(r"<script[^>]*r='m'[^>]*>\s*(\$_ts=.*?)</script>", html, re.DOTALL)
    vm = re.search(r'<script[^>]*src="(/[^"]+\.js)"', html)
    if not (meta and script and vm):
        raise RuntimeError("412 页结构变化")
    arg1 = re.search(r'content="([^"]*)"', meta.group(0)).group(1)
    arg2 = script.group(1).strip()
    ts_code = session.get(TARGET.rstrip("/") + vm.group(1),
                          headers={"User-Agent": UA, "Referer": TARGET},
                          impersonate="chrome110", timeout=20, verify=False).text

    env_js = ENV_TEMPLATE.read_text(encoding="utf-8")
    env_js = env_js.replace("arg1_content", arg1).replace('"arg2_js"', arg2).replace('"ts_code"', ts_code)
    env_js += (
        '\n;setTimeout(function(){ console.log("COOKIE_START:" + get_cookie()'
        ' + ":COOKIE_END"); process.exit(0); }, %d);' % WAIT_MS)
    tmp = HERE / "_run_tmp.js"
    tmp.write_text(env_js, encoding="utf-8")
    try:
        r = subprocess.run(["node", str(tmp)], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=60,
                           cwd=str(HERE))
    finally:
        tmp.unlink()
    m = re.search(r"COOKIE_START:(.*?):COOKIE_END", r.stdout + r.stderr, re.S)
    if not m:
        raise RuntimeError(f"P-cookie 生成失败: {(r.stdout + r.stderr)[-300:]}")
    for part in m.group(1).strip().split(";"):
        part = part.strip()
        if "=" in part and not part.startswith(("path=", "expires=", "Secure", "domain=")):
            k, _, v = part.partition("=")
            session.cookies.set(k.strip(), v.strip())
    return session


def fetch(session, url, referer=TARGET):
    resp = session.get(url, headers={"User-Agent": UA, "Referer": referer},
                       impersonate="chrome110", timeout=20, verify=False)
    if resp.status_code == 412:
        for i in range(MAX_REGENS):
            generate_cookies(session)
            resp = session.get(url, headers={"User-Agent": UA, "Referer": referer},
                               impersonate="chrome110", timeout=20, verify=False)
            if resp.status_code != 412:
                break
    return resp


def main():
    t0 = time.time()
    session = requests.Session()
    generate_cookies(session)
    resp = fetch(session, TARGET)
    print(f"状态 {resp.status_code}, {len(resp.text)}B, 用时 {time.time() - t0:.1f}s")
    if resp.status_code == 200 and len(resp.text) > 3000:
        (HERE / "tj_200.html").write_text(resp.text, encoding="utf-8")
        print("已保存 tj_200.html")


if __name__ == "__main__":
    main()
