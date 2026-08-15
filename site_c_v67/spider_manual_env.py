# -*- coding: utf-8 -*-
"""
站点C（医院）瑞数 — 手动补环境爬虫 (纯 Node, 无浏览器, ~3s/次)

原理:
  1. curl_cffi 请求目标页 -> 412 挑战页 + O-cookie (Set-Cookie)
  2. 提取 meta content + $_ts 初始化脚本 + VM JS (304KB)
  3. 注入 browser_envs.js (手动补环境模板) 用 Node 执行
  4. 定时器异步 + try/catch — 关键! 同步 flush 会跳过 VM 的 timer 阶段
     导致 basearr 少 30 字节被服务端拒收
  5. 1.5s 后读 P-cookie (实测 1s 即就绪)
  6. 同一 session 带 O+P cookie 重请求 -> 200

用法: python spider_manual_env.py
"""
import base64
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from curl_cffi import requests

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SCRIPT_DIR = Path(__file__).parent
TARGET_URL = base64.b64decode(
    "aHR0cHM6Ly9zdWdoLnN6dS5lZHUuY24vSHRtbC9OZXdzL01haW4vMTAyLmh0bWw=").decode()
BASE_URL = base64.b64decode("aHR0cHM6Ly9zdWdoLnN6dS5lZHUuY24=").decode()
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
ENV_TEMPLATE = SCRIPT_DIR / "env" / "browser_envs.js"
WAIT_MS = 1500  # cookie 就绪等待 (实测 1s 就绪)


def generate_cookies():
    """Step 1-3: 412 -> O-cookie; Node 补环境执行 VM -> P-cookie; 返回带 O+P 的 session"""
    session = requests.Session()

    print("[1/3] curl_cffi 获取 412 挑战页...")
    resp = session.get(TARGET_URL, headers={"User-Agent": UA},
                       impersonate="chrome110", timeout=15)
    if resp.status_code != 412:
        raise RuntimeError(f"Expected 412, got {resp.status_code}")
    html = resp.text
    meta = re.search(r'<meta[^>]*r=[\'"]m[\'"][^>]*>', html)  # 按 r='m' 定位, meta id 每轮可能轮换
    script = re.search(r"<script[^>]*r='m'[^>]*>\s*(\$_ts=.*?)</script>", html, re.DOTALL)
    vm = re.search(r'<script[^>]*src="(/[^"]+\.js)"', html)
    arg1 = re.search(r'content="([^"]*)"', meta.group(0)).group(1)
    arg2 = script.group(1).strip()
    vm_url = BASE_URL + vm.group(1)
    ts_code = session.get(vm_url, headers={"User-Agent": UA, "Referer": TARGET_URL},
                          impersonate="chrome110", timeout=15).text
    print(f"  arg1: {len(arg1)} chars, arg2: {len(arg2)} chars, VM: {len(ts_code)} bytes")

    print(f"[2/3] Node 补环境执行 VM (等 {WAIT_MS}ms)...")
    env_js = ENV_TEMPLATE.read_text(encoding="utf-8")
    env_js = env_js.replace("arg1_content", arg1)
    env_js = env_js.replace('"arg2_js"', arg2)
    env_js = env_js.replace('"ts_code"', ts_code)
    env_js += (
        f'\n;setTimeout(function(){{ console.log("COOKIE_START:" + get_cookie() + ":COOKIE_END"); process.exit(0); }}, {WAIT_MS});'
    )

    tmp = SCRIPT_DIR / "_run_tmp.js"
    tmp.write_text(env_js, encoding="utf-8")
    try:
        r = subprocess.run(["node", str(tmp)], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=60,
                           cwd=str(SCRIPT_DIR))
    finally:
        tmp.unlink()
    out = r.stdout + r.stderr
    m = re.search(r"COOKIE_START:(.*?):COOKIE_END", out, re.S)
    if not m:
        raise RuntimeError(f"P-cookie 生成失败, 输出尾部:\n{out[-800:]}")
    p_cookie = m.group(1).strip()
    print(f"  P-cookie: {len(p_cookie)} chars")

    print("[3/3] 合并 O+P cookie...")
    for part in p_cookie.split(";"):
        part = part.strip()
        if "=" in part and not part.startswith(("path=", "expires=", "Secure", "domain=")):
            k, _, v = part.partition("=")
            session.cookies.set(k.strip(), v.strip())
    return session


if __name__ == "__main__":
    t0 = time.time()
    session = generate_cookies()
    resp = session.get(TARGET_URL, headers={"User-Agent": UA, "Referer": BASE_URL + "/"},
                       impersonate="chrome110", timeout=20)
    elapsed = time.time() - t0
    links = re.findall(r'href="(/Html/News/Articles/\d+\.html)"', resp.text)
    print(f"\n结果: {resp.status_code} | {len(resp.text)} bytes | {len(links)} 个文章链接 | 总耗时 {elapsed:.1f}s")
    if resp.status_code == 200:
        (SCRIPT_DIR / "page_200_manual_env.html").write_text(resp.text, encoding="utf-8")
        print("手动补环境成功!")
