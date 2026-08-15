"""
方案 4: Camoufox 0.5.4 反检测浏览器

原理:
  1. Camoufox (引擎级指纹伪装的 Firefox) 加载目标页, 挑战自动完成
  2. 提取 cookie -> curl_cffi 复用轻量爬取

依赖:
  pip install camoufox[geoip]
  首次运行会自动下载 Camoufox 浏览器 (~100MB)

用法: python spider_camoufox.py

注意:
  - camoufox 的 sync_api 在 close() 后会泄漏 running event loop 到主线程,
    同进程内后续再启动任何 Playwright sync 引擎会报
    "Playwright Sync API inside the asyncio loop"。修复:
        import asyncio
        asyncio._set_running_loop(None)
        asyncio.set_event_loop(asyncio.new_event_loop())
"""
import base64
import re
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
TARGET_URL = base64.b64decode(
    "aHR0cHM6Ly9zdWdoLnN6dS5lZHUuY24vSHRtbC9OZXdzL01haW4vMTAyLmh0bWw=").decode()
BASE_URL = base64.b64decode("aHR0cHM6Ly9zdWdoLnN6dS5lZHUuY24=").decode()
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36")
MAX_WAIT = 30  # 挑战最长等待秒数


if __name__ == "__main__":
    from camoufox.sync_api import Camoufox

    t0 = time.time()
    print("[1/2] Camoufox 加载 (等待挑战自动完成)...")
    browser = Camoufox(headless=False, humanize=True).__enter__()
    page = browser.new_page()
    try:
        page.goto(TARGET_URL, timeout=30000, wait_until="domcontentloaded")
    except Exception:
        pass

    html = None
    for _ in range(MAX_WAIT):
        time.sleep(1)
        try:
            if len(page.content()) > 5000:
                html = page.content()
                break
        except Exception:
            pass
    if not html:
        print(f"[FAIL] {MAX_WAIT}s 内未通过挑战")
        browser.close()
        raise SystemExit(1)
    print(f"  挑战通过 ({time.time() - t0:.0f}s), 页面 {len(html)} bytes")

    print("[2/2] 提取 cookie -> curl_cffi 复用...")
    cookie_jar = {c["name"]: c["value"] for c in page.context.cookies()
                  if len(c["value"]) > 5}
    browser.close()
    print(f"  提取 {len(cookie_jar)} 个 cookie")

    from curl_cffi import requests
    s = requests.Session()
    for k, v in cookie_jar.items():
        s.cookies.set(k, v)
    resp = s.get(TARGET_URL, headers={"User-Agent": UA, "Referer": BASE_URL + "/"},
                 impersonate="chrome110", timeout=20)
    elapsed = time.time() - t0
    links = re.findall(r'href="(/Html/News/Articles/\d+\.html)"', resp.text)
    print(f"\n结果: {resp.status_code} | {len(resp.text)} bytes | {len(links)} 个文章链接 | 总耗时 {elapsed:.1f}s")
    if resp.status_code == 200:
        (SCRIPT_DIR / "site_c_200_camoufox.html").write_text(resp.text, encoding="utf-8")
