"""
站点B（招聘平台）— 瑞数纯算法还原爬虫（rs-reverse 方案）

原理:
  1. curl_cffi (Chrome TLS) 请求目标页 -> 412 + O cookie
  2. node rs-reverse makecookie -u 还原 VM 算法 -> 计算 P cookie
     (rs-reverse 自己会再发一次请求拿 412 动态参数, 与 O cookie 同轮配对)
  3. 解析 stdout 的 O+P cookie -> 加入 session
  4. curl_cffi 带 O+P 重请求 -> 200

依赖:
  pip install curl_cffi
  npm install rs-reverse   # 在本目录执行
  python patch_rs_reverse.py   # 安装后打 2 个 Windows 补丁

用法: python spider.py
成功: 当前目录保存 site_b_200.html
"""
import re
import base64
import subprocess
from pathlib import Path

from curl_cffi import requests

SCRIPT_DIR = Path(__file__).parent
TARGET_URL = base64.b64decode("aHR0cHM6Ly96aGFvcGluLnNnY2MuY29tLmNuLw==").decode()
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138"


def generate_cookies():
    """Step 1+2: 412 -> O cookie; rs-reverse 纯算法 -> O+P cookie; 返回带双 cookie 的 session"""
    session = requests.Session()

    print("[1/3] curl_cffi 获取 412 挑战页...")
    resp = session.get(TARGET_URL, headers={"User-Agent": UA},
                       impersonate="chrome110", timeout=15)
    if resp.status_code != 412:
        raise RuntimeError(f"Expected 412, got {resp.status_code}. "
                           f"站点可能已升级或 IP 被限流")
    o_names = list(session.cookies.keys())
    print(f"  412 页 {len(resp.text)} bytes, O cookie: {o_names}")

    print("[2/3] rs-reverse 纯算法计算 P cookie...")
    # 动态定位 rs-reverse main.js（node 向上查找: 本目录或上级 node_modules）
    main_js = subprocess.run(
        ["node", "-e", "console.log(require.resolve('rs-reverse'))"],
        capture_output=True, text=True, cwd=str(SCRIPT_DIR),
    ).stdout.strip()
    if not main_js:
        raise RuntimeError("未找到 rs-reverse 模块, 先 npm install rs-reverse")
    result = subprocess.run(
        ["node", main_js, "makecookie", "-u", TARGET_URL, "-l", "warn"],
        capture_output=True, text=True, timeout=120,
        cwd=str(SCRIPT_DIR),
    )
    if result.returncode != 0:
        raise RuntimeError(f"makecookie 失败:\n{result.stderr[-1500:]}")

    # 解析 stdout: "cookie值: O=xxx;P=yyy"
    m = re.search(r"cookie值:\s*([^\n]+)", result.stdout + result.stderr)
    if not m:
        raise RuntimeError(f"未解析到 cookie 值:\n{(result.stdout + result.stderr)[-1000:]}")
    cookie_str = m.group(1).strip()

    print(f"[3/3] 解析 cookie ({len(cookie_str)} chars), 加入 session...")
    for part in cookie_str.split(";"):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            session.cookies.set(k.strip(), v.strip())
    return session


if __name__ == "__main__":
    print("=" * 60)
    print("rs-reverse 纯算法 — 站点B 瑞数")
    print("=" * 60)

    session = generate_cookies()

    print("\n[验证] 带 O+P cookie 重请求...")
    resp = session.get(TARGET_URL, headers={"User-Agent": UA, "Referer": TARGET_URL},
                       impersonate="chrome110", timeout=20)
    print(f"  状态: {resp.status_code}, 大小: {len(resp.text)} bytes")

    if resp.status_code == 200:
        out = SCRIPT_DIR / "site_b_200.html"
        out.write_text(resp.text, encoding="utf-8")
        print(f"  [OK] 200 通过, 已保存: {out}")
    else:
        print(f"  [FAIL] 验证失败: {resp.status_code}")
        raise SystemExit(1)
