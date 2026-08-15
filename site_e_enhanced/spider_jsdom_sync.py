"""
方案 2: jsdom + 同步 flush (sdenv 提速版) — 无浏览器纯算路线, 推荐

原理:
  1. curl_cffi (Chrome TLS) 请求目标页 -> 412 挑战页 + O-cookie (Set-Cookie)
  2. curl_cffi 下载 VM 解释器 JS (带 O cookie + Referer)
  3. node jsdom_gen.js: sdenv 的 jsdom 完整环境执行瑞数 VM
     ★ 同步 flush: setTimeout/setInterval 收集回调立即执行, 不等真实时间
       (决定性实验证明瑞数 VM 状态机不依赖 timer 时序, 环境才是关键)
     -> P-cookie 秒出, 且比真实 timer 版更长 (421 vs 343 chars)
  4. 同一 session 带 O+P cookie 重请求 -> 200

依赖:
  pip install curl_cffi
  npm install sdenv     # 在本目录执行

用法: python spider_jsdom_sync.py
成功: 当前目录保存 site_e_200_jsdom_sync.html
"""
import base64
import json
import re
import subprocess
from pathlib import Path

from curl_cffi import requests

SCRIPT_DIR = Path(__file__).parent
TARGET_URL = base64.b64decode(
    "aHR0cHM6Ly93d3cuY2FpY3QuYWMuY24va3h5ai9xd2ZiL2Jwcy8=").decode()
BASE_URL = base64.b64decode("aHR0cHM6Ly93d3cuY2FpY3QuYWMuY24=").decode()
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146"


def generate_cookies():
    """412 -> O-cookie + JS; jsdom 同步 flush 执行 VM -> P-cookie; 返回带 O+P 的 session"""
    session = requests.Session()

    print("[1/4] curl_cffi 获取 412 挑战页...")
    resp = session.get(TARGET_URL, headers={"User-Agent": UA},
                       impersonate="chrome110", timeout=15)
    if resp.status_code != 412:
        raise RuntimeError(f"Expected 412, got {resp.status_code}")
    print(f"  412 页 {len(resp.text)} bytes, O-cookie: {list(session.cookies.keys())}")

    html_path = SCRIPT_DIR / "_412.html"
    html_path.write_text(resp.text, encoding="utf-8")

    # 提取 $_ts 配置 (nsd + cd)
    nsd_m = re.search(r"\$_ts\.nsd\s*=\s*(\d+)", resp.text)
    cd_m = re.search(r"\$_ts\.cd\s*=\s*[\"']([^\"']+)[\"']", resp.text)
    if not nsd_m or not cd_m:
        raise RuntimeError("412 页面未找到 $_ts 配置")
    ts_path = SCRIPT_DIR / "_ts_config.json"
    ts_path.write_text(json.dumps({"nsd": int(nsd_m.group(1)), "cd": cd_m.group(1)}),
                       encoding="utf-8")

    print("[2/4] curl_cffi 下载 VM 解释器 JS...")
    m = re.search(r"src=[\"']([^\"']+?\.js[^\"']*)[\"']", resp.text)
    if not m:
        raise RuntimeError("412 页面未找到核心 JS URL")
    js_url = m.group(1)
    if js_url.startswith("//"):
        js_url = "https:" + js_url
    elif js_url.startswith("/"):
        js_url = BASE_URL + js_url
    js_resp = session.get(js_url, headers={"User-Agent": UA, "Referer": TARGET_URL},
                          impersonate="chrome110", timeout=15)
    if js_resp.status_code != 200:
        raise RuntimeError(f"核心 JS 下载失败: {js_resp.status_code}")
    js_path = SCRIPT_DIR / "_core.js"
    js_path.write_text(js_resp.text, encoding="utf-8")
    print(f"  JS {len(js_resp.text)} bytes")

    print("[3/4] jsdom 同步 flush 执行 VM...")
    o_cookie = "; ".join(f"{k}={v}" for k, v in session.cookies.items())
    result = subprocess.run(
        ["node", str(SCRIPT_DIR / "jsdom_gen.js"),
         f"--html={html_path}", f"--js={js_path}", f"--ts={ts_path}",
         f"--cookieo={o_cookie}", f"--url={TARGET_URL}"],
        capture_output=True, text=True, timeout=60,
        cwd=str(SCRIPT_DIR),
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError(f"node 执行失败:\n{result.stderr[-1500:]}")

    out = json.loads(result.stdout.strip())
    print(f"[4/4] P-cookie: {len(out['P'])} chars (key={out['pKey']}), 加入 session...")

    for part in out["cookie"].split(";"):
        part = part.strip()
        if "=" in part and not part.startswith(
            ("path=", "expires=", "Secure", "domain=", "Max-Age=", "HttpOnly")
        ):
            k, v = part.split("=", 1)
            session.cookies.set(k.strip(), v.split(";")[0].strip())

    for tmp in (html_path, js_path, ts_path):
        try:
            tmp.unlink()
        except OSError:
            pass
    return session


if __name__ == "__main__":
    print("=" * 60)
    print("方案2: jsdom 同步 flush — 站点E 瑞数")
    print("=" * 60)

    session = generate_cookies()

    print("\n[验证] 带 O+P cookie 重请求...")
    resp = session.get(TARGET_URL, headers={"User-Agent": UA, "Referer": TARGET_URL},
                       impersonate="chrome110", timeout=15)
    print(f"  状态: {resp.status_code}, 大小: {len(resp.text)} bytes")

    if resp.status_code == 200:
        out = SCRIPT_DIR / "site_e_200_jsdom_sync.html"
        out.write_text(resp.text, encoding="utf-8")
        m = re.search(r"<title>([^<]*)</title>", resp.text)
        print(f"  ✅ 200 通过, 页面: {m.group(1) if m else '?'}")
        print(f"  已保存: {out}")
    else:
        print(f"  ❌ 验证失败: {resp.status_code}")
        raise SystemExit(1)
