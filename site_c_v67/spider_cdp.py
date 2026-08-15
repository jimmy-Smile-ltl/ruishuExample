"""
方案 3: 原生 CDP 直连真实 Chrome (零注入配方)

原理:
  1. 命令行启动真实 chrome.exe (--headless=new), 通过 CDP 协议接管
  2. 导航用 renderer 跳转 (Runtime.evaluate location.href), 不用 Page.navigate
  3. 零 JS 注入 — 不注入任何 stealth 脚本 (瑞数 VM 会检测 navigator
     属性描述符被篡改, 静默放弃出 cookie)
  4. 挑战自动完成后, 用 Network.getCookies 提取 cookie (含 HttpOnly)
  5. curl_cffi 复用 cookie 轻量爬取

配方四要素 (实测 5/5 大学站):
  - 真实 chrome.exe + --headless=new + --user-agent=Chrome/138
  - 零 JS 注入
  - renderer 跳转
  - --remote-allow-origins=* (Chrome 151+ 必须); --user-data-dir 必须绝对路径

依赖:
  pip install websocket-client curl_cffi
  系统安装 Chrome (默认路径 C:/Program Files/Google/Chrome/Application/chrome.exe)

用法: python spider_cdp.py
"""
import base64
import json
import random
import re
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
TARGET_URL = base64.b64decode(
    "aHR0cHM6Ly9zdWdoLnN6dS5lZHUuY24vSHRtbC9OZXdzL01haW4vMTAyLmh0bWw=").decode()
BASE_URL = base64.b64decode("aHR0cHM6Ly9zdWdoLnN6dS5lZHUuY24=").decode()
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36")
MAX_WAIT = 40  # 挑战最长等待秒数


class CDPBrowser:
    """最小 CDP 客户端: 启动 Chrome -> 开 tab -> renderer 跳转 -> 轮询"""

    def __init__(self):
        self.port = random.randint(20000, 45000)
        self.profile = Path(tempfile.mkdtemp(prefix="cdp_ruishu_"))  # 绝对路径必须
        args = [CHROME, "--headless=new", f"--remote-debugging-port={self.port}",
                "--remote-allow-origins=*", f"--user-data-dir={self.profile}",
                "--no-first-run", "--no-default-browser-check", f"--user-agent={UA}",
                "about:blank"]
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL)
        for _ in range(60):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json/version", timeout=1)
                return
            except Exception:
                time.sleep(0.5)
        raise RuntimeError("Chrome did not start (port never opened)")

    def new_tab(self, url):
        import websocket as wslib
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/json/new?about:blank", method="PUT")
        tab = json.loads(urllib.request.urlopen(req, timeout=5).read())
        ws = wslib.create_connection(tab["webSocketDebuggerUrl"], timeout=30)
        self.ws = ws
        self._mid = 0
        for m in ("Page.enable", "Runtime.enable", "Network.enable"):
            self._cmd(m)
        # renderer 跳转 (关键: 不用 Page.navigate)
        self._eval(f"location.href = {json.dumps(url)}")

    def _cmd(self, method, params=None):
        import websocket as wslib
        self._mid += 1
        mid = self._mid
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        for _ in range(500):
            try:
                msg = json.loads(self.ws.recv())
            except wslib.WebSocketTimeoutException:
                continue
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    def _eval(self, expr):
        r = self._cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        v = r.get("result", {})
        if v.get("subtype") == "error":
            raise RuntimeError(v.get("description", "eval error"))
        return v.get("value")

    def wait_challenge(self):
        """轮询页面 DOM, 挑战通过后返回 html"""
        for _ in range(MAX_WAIT):
            time.sleep(1)
            try:
                info = self._eval("({l: document.documentElement.outerHTML.length})")
            except Exception:
                continue
            if info and info.get("l", 0) > 5000:
                return self._eval("document.documentElement.outerHTML")
        return None

    def get_cookies(self):
        """Network.getCookies: 含 HttpOnly 的 O-cookie"""
        r = self._cmd("Network.getCookies", {"urls": [TARGET_URL]})
        return {c["name"]: c["value"] for c in r.get("cookies", []) if len(c["value"]) > 5}

    def close(self):
        try:
            self.proc.terminate()
        except Exception:
            pass


if __name__ == "__main__":
    t0 = time.time()
    cdp = CDPBrowser()
    print("[1/2] Chrome 已启动, renderer 跳转 + 等待挑战...")
    cdp.new_tab(TARGET_URL)
    html = cdp.wait_challenge()
    if not html:
        print(f"[FAIL] {MAX_WAIT}s 内未通过挑战")
        cdp.close()
        raise SystemExit(1)
    print(f"  挑战通过 ({time.time() - t0:.0f}s), 页面 {len(html)} bytes")

    print("[2/2] 提取 cookie -> curl_cffi 复用...")
    cookie_jar = cdp.get_cookies()
    cdp.close()
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
        (SCRIPT_DIR / "site_c_200_cdp.html").write_text(resp.text, encoding="utf-8")
