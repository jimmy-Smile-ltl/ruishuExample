"""
方案 3: CloakBrowser 隐身浏览器 — 浏览器原生过挑战

原理:
  1. CloakBrowser (C++ 补丁 Chromium, 58 项指纹修正) 直接加载目标页
  2. 瑞数挑战在真实浏览器里自动完成: 412 -> VM 执行 -> 双 Cookie -> 自动重载
  3. page.context.cookies() 提取 Cookie (含 HttpOnly 的 O)
  4. 重新导航验证 200

依赖:
  pip install cloakbrowser   # 首次运行自动下载 stealth Chromium (~200MB)

用法: python spider_cloakbrowser.py
成功: 当前目录保存 site_e_200_cloakbrowser.html
"""
import base64
import time
from pathlib import Path

from cloakbrowser import launch

SCRIPT_DIR = Path(__file__).parent
TARGET_URL = base64.b64decode(
    "aHR0cHM6Ly93d3cuY2FpY3QuYWMuY24va3h5ai9xd2ZiL2Jwcy8=").decode()
HOSTNAME = base64.b64decode("d3d3LmNhaWN0LmFjLmNu").decode()
O_PREFIX = base64.b64decode("cUNSZA==").decode()  # O-cookie 名前缀 (站点E cookie 家族)
MAX_ATTEMPTS = 15  # 列表页首次命中率 ~20%, 重试保证成功率


def get_valid_page():
    """带重试的挑战通过: 412 -> 等 Cookie -> 重载 -> 200 页面"""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        print(f"  Attempt {attempt}/{MAX_ATTEMPTS}...", end=" ", flush=True)
        browser = launch(headless=True, humanize=True)
        try:
            page = browser.new_page()
            page.goto("about:blank", timeout=10000)
            time.sleep(0.2)

            try:
                page.goto(TARGET_URL, timeout=30000, wait_until="domcontentloaded")
            except Exception:
                # 412 → 等 Cookie 生成 → 重试
                time.sleep(5)
                cookies = page.context.cookies()
                if not any(c["name"].startswith(O_PREFIX) for c in cookies):
                    raise
                page.goto("about:blank", timeout=10000)
                time.sleep(0.2)
                page.goto(TARGET_URL, timeout=30000, wait_until="domcontentloaded")

            time.sleep(2)
            title = page.title()
            if title == HOSTNAME or not title:
                raise Exception("bad page")

            html = page.content()
            print(f"ok ({title})")
            return browser, page, html
        except Exception:
            print("fail")
            try:
                page.close()
                browser.close()
            except Exception:
                pass
    raise RuntimeError(f"{MAX_ATTEMPTS} 次尝试后仍未通过挑战")


if __name__ == "__main__":
    print("=" * 60)
    print("方案3: CloakBrowser — 站点E 瑞数")
    print("=" * 60)

    browser, page, html = get_valid_page()

    out = SCRIPT_DIR / "site_e_200_cloakbrowser.html"
    out.write_text(html, encoding="utf-8")
    print(f"✅ 200 通过, 页面: {page.title()}")
    print(f"  已保存: {out}")

    cookies = page.context.cookies()
    qcrd = [c for c in cookies if c["name"].startswith(O_PREFIX)]
    print(f"  O-cookie: {len(qcrd)} 个")
    for c in qcrd:
        print(f"    {c['name']} ({len(c['value'])} chars)")

    page.close()
    browser.close()
