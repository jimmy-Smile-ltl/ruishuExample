"""
方案 1: sdenv (jsdom 补环境) — 无浏览器纯算路线

原理:
  1. curl_cffi (Chrome TLS) 请求目标页 -> 412 挑战页 + O-cookie (Set-Cookie)
  2. sdenv 在 Node.js 里用 jsdom 加载 412 页并执行瑞数 VM -> P-cookie
     (真实 timer, 等 8s 让 VM 走完 cookie 生成链)
  3. 同一 session 带 O+P cookie 重请求 -> 200

依赖:
  pip install curl_cffi
  npm install sdenv     # 在本目录执行

用法: python spider_sdenv.py
成功: 当前目录保存 site_e_200_sdenv.html
"""
import base64
import json
import subprocess
from pathlib import Path

from curl_cffi import requests

SCRIPT_DIR = Path(__file__).parent
TARGET_URL = base64.b64decode(
    "aHR0cHM6Ly93d3cuY2FpY3QuYWMuY24va3h5ai9xd2ZiL2Jwcy8=").decode()
BASE_URL = base64.b64decode("aHR0cHM6Ly93d3cuY2FpY3QuYWMuY24=").decode()
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146"

WAIT_COOKIE_MS = 8000  # sdenv 内等瑞数 VM 出 cookie 的时间


def generate_cookies():
    """Step 1+2: 412 -> O-cookie; sdenv 执行 VM -> P-cookie; 返回带 O+P 的 session"""
    session = requests.Session()

    print("[1/3] curl_cffi 获取 412 挑战页...")
    resp = session.get(TARGET_URL, headers={"User-Agent": UA},
                       impersonate="chrome110", timeout=15)
    if resp.status_code != 412:
        raise RuntimeError(f"Expected 412, got {resp.status_code}")
    html_path = SCRIPT_DIR / "_412.html"
    html_path.write_text(resp.text, encoding="utf-8")
    print(f"  412 页 {len(resp.text)} bytes, O-cookie: {list(session.cookies.keys())}")

    print(f"[2/3] sdenv 执行瑞数 VM (等 {WAIT_COOKIE_MS // 1000}s)...")
    node_script = f"""
var fs = require('fs');
var {{ jsdomFromText }} = require('sdenv');

var html = fs.readFileSync({json.dumps(str(html_path))}, 'utf-8');

var dom = jsdomFromText(html, {{
  url: {json.dumps(TARGET_URL)},
  referrer: {json.dumps(BASE_URL + '/')},
  runScripts: 'dangerously',
  resources: 'usable',
  browserType: 'chrome',
  beforeParse: function(window) {{
    // try/catch 包裹定时器回调: 缺失 API 不崩溃, cookie 照常生成
    var st = window.setTimeout, si = window.setInterval;
    window.setTimeout = function(fn, d) {{
      return st(function() {{ try {{ fn(); }} catch(e) {{}} }}, d);
    }};
    window.setInterval = function(fn, d) {{
      return si(function() {{ try {{ fn(); }} catch(e) {{}} }}, d);
    }};
  }}
}});

setTimeout(function() {{
  var cookie = dom.window.document.cookie;
  console.log(cookie);
  dom.window.close();
}}, {WAIT_COOKIE_MS});
"""

    node_path = SCRIPT_DIR / "_gen_cookie.js"
    node_path.write_text(node_script, encoding="utf-8")

    result = subprocess.run(
        ["node", str(node_path)],
        capture_output=True, text=True, timeout=30,
        cwd=str(SCRIPT_DIR),
    )
    ck = result.stdout.strip()

    print(f"[3/3] P-cookie: {len(ck)} chars, 加入 session...")
    for part in ck.split(";"):
        part = part.strip()
        if "=" in part and not part.startswith(
            ("path=", "expires=", "Secure", "domain=", "Max-Age=", "HttpOnly")
        ):
            k, v = part.split("=", 1)
            session.cookies.set(k.strip(), v.split(";")[0].strip())

    for tmp in (html_path, node_path):
        try:
            tmp.unlink()
        except OSError:
            pass
    return session


if __name__ == "__main__":
    print("=" * 60)
    print("方案1: sdenv jsdom 补环境 — 站点E 瑞数")
    print("=" * 60)

    session = generate_cookies()

    print("\n[验证] 带 O+P cookie 重请求...")
    resp = session.get(TARGET_URL, headers={"User-Agent": UA, "Referer": TARGET_URL},
                       impersonate="chrome110", timeout=15)
    print(f"  状态: {resp.status_code}, 大小: {len(resp.text)} bytes")

    if resp.status_code == 200:
        out = SCRIPT_DIR / "site_e_200_sdenv.html"
        out.write_text(resp.text, encoding="utf-8")
        m = __import__("re").search(r"<title>([^<]*)</title>", resp.text)
        print(f"  ✅ 200 通过, 页面: {m.group(1) if m else '?'}")
        print(f"  已保存: {out}")
    else:
        print(f"  ❌ 验证失败: {resp.status_code}")
        raise SystemExit(1)
