"""
方案 2: DrissionPage 过挑战 + curl_cffi cookie 复用

原理:
  1. DrissionPage 驱动系统 Chrome (真实浏览器, 零 JS 注入) 加载目标页
  2. 浏览器里瑞数挑战自动完成 (412 -> VM 出 cookie -> 自动重载 200), ~3s
  3. 提取浏览器 cookie jar (含全部随机名 O/P cookie 对)
  4. curl_cffi 复用 cookie 轻量爬取后续页面 (不再需要浏览器)

依赖:
  pip install DrissionPage curl_cffi
  系统安装 Chrome

用法: python spider_drission.py
"""
import base64
import re
import time
from pathlib import Path

from DrissionPage import ChromiumPage, ChromiumOptions

SCRIPT_DIR = Path(__file__).parent
TARGET_URL = base64.b64decode(
    "aHR0cHM6Ly9zdWdoLnN6dS5lZHUuY24vSHRtbC9OZXdzL01haW4vMTAyLmh0bWw=").decode()
BASE_URL = base64.b64decode("aHR0cHM6Ly9zdWdoLnN6dS5lZHUuY24=").decode()
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36")
MAX_WAIT = 30  # 挑战最长等待秒数


def pass_challenge_and_get_cookies():
    """DrissionPage 过挑战, 返回浏览器 cookie jar (dict)"""
    co = ChromiumOptions()
    co.headless(True)
    co.set_user_agent(UA)
    co.set_argument('--remote-allow-origins=*')
    page = ChromiumPage(co)

    print("[1/2] 浏览器加载 (等待瑞数挑战自动完成)...")
    t0 = time.time()
    try:
        page.get(TARGET_URL, timeout=30)
    except Exception as e:
        print(f"  get() exception (可忽略): {e}")

    for _ in range(MAX_WAIT):
        time.sleep(1)
        try:
            if len(page.html) > 5000 and '/Html/News/Articles/' in page.html:
                print(f"  挑战通过 ({time.time() - t0:.0f}s), 页面 {len(page.html)} bytes")
                break
        except Exception:
            pass
    else:
        raise RuntimeError(f"{MAX_WAIT}s 内未通过挑战")

    print("[2/2] 提取 cookie jar...")
    cookie_jar = {}
    for c in page.cookies(all_domains=True):
        if len(c.get('value', '')) > 5:
            cookie_jar[c['name']] = c['value']
    page.quit()
    print(f"  提取 {len(cookie_jar)} 个 cookie")
    return cookie_jar


if __name__ == "__main__":
    t0 = time.time()
    cookie_jar = pass_challenge_and_get_cookies()

    # curl_cffi 复用 (之后所有请求都用它, 浏览器已关闭)
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
        (SCRIPT_DIR / "site_c_200_drission.html").write_text(resp.text, encoding="utf-8")
