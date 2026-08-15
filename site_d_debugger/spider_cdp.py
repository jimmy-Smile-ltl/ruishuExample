"""
原生 CDP 零注入 — 瑞数挑战 (备选方案, 最快 ~2-5s/页)

配方四要素 (pro36 五所大学站 5/5 实测):
  1. 真实 chrome.exe + --headless=new + --user-agent=Chrome/138
  2. 零 JS 注入 — 任何 stealth 脚本都会改 navigator 属性描述符,
     瑞数 VM 检测到篡改后静默放弃出 cookie
  3. 导航用 renderer 跳转 Runtime.evaluate("location.href=..."), 不用 Page.navigate
  4. Chrome 151+ 必须带 --remote-allow-origins=*; --user-data-dir 必须绝对路径

依赖:
  pip install websocket-client psutil

用法:
    python spider_cdp.py                 # 默认: 首页 + /datasearch/
    python spider_cdp.py --url <URL>     # 单 URL
"""
import argparse
import base64
import json
import random
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
UA138 = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36')
PROJ = Path(__file__).parent
PROFILE = (PROJ / 'cdp_profile').resolve()


class CDPClient:
    """真实 Chrome + CDP 直连, 零注入, renderer 跳转"""

    def __init__(self, headless=True):
        self.port = random.randint(20000, 45000)
        self.profile = PROFILE
        self._mid = 0
        self._launch(headless)

    def _kill_lingering(self):
        try:
            import psutil
            for p in psutil.process_iter(['name', 'cmdline']):
                try:
                    if p.info['name'] == 'chrome.exe' and \
                            any(self.profile.name in (c or '') for c in p.info['cmdline'] or []):
                        p.kill()
                except Exception:
                    pass
            time.sleep(1)
        except Exception:
            pass

    def _launch(self, headless):
        self._kill_lingering()
        args = [CHROME, f'--remote-debugging-port={self.port}',
                '--remote-allow-origins=*', f'--user-data-dir={self.profile}',
                '--no-first-run', '--no-default-browser-check',
                f'--user-agent={UA138}']
        if headless:
            args.insert(1, '--headless=new')
        args.append('about:blank')
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL)
        # 注意: 提权会话下 Chrome 137+ 会自我降权重启 (父进程退出码0),
        # 真正浏览器在子进程里, 所以只信端口不信进程退出
        for _ in range(60):
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{self.port}/json/version', timeout=1)
                return
            except Exception:
                time.sleep(0.5)
        raise RuntimeError('Chrome did not start (port never opened)')

    def _cmd(self, ws, method, params=None):
        import websocket as wslib
        self._mid += 1
        mid = self._mid
        ws.send(json.dumps({'id': mid, 'method': method, 'params': params or {}}))
        for _ in range(500):
            try:
                msg = json.loads(ws.recv())
            except wslib.WebSocketTimeoutException:
                continue
            if msg.get('id') == mid:
                if 'error' in msg:
                    raise RuntimeError(f'{method}: {msg["error"]}')
                return msg.get('result', {})
        raise RuntimeError(f'{method}: no response')

    def _eval(self, ws, expr):
        r = self._cmd(ws, 'Runtime.evaluate', {'expression': expr, 'returnByValue': True})
        v = r.get('result', {})
        if v.get('subtype') == 'error':
            raise RuntimeError(v.get('description', 'eval error'))
        return v.get('value')

    def get(self, url, max_retries=2):
        """打开新 tab 访问 URL, 等待瑞数挑战完成后返回 HTML"""
        import websocket as wslib
        for attempt in range(1, max_retries + 1):
            req = urllib.request.Request(
                f'http://127.0.0.1:{self.port}/json/new?about:blank', method='PUT')
            tab = json.loads(urllib.request.urlopen(req, timeout=5).read().decode('utf-8', errors='replace'))
            ws = wslib.create_connection(tab['webSocketDebuggerUrl'], timeout=30)
            self._cmd(ws, 'Page.enable')
            self._cmd(ws, 'Runtime.enable')
            self._cmd(ws, 'Network.enable')
            self._eval(ws, f'location.href = {json.dumps(url)}')  # ★ renderer 跳转
            t0 = time.time()
            while time.time() - t0 < 40:
                time.sleep(1)
                try:
                    info = self._eval(ws, "({l: document.documentElement.outerHTML.length,"
                                          " t: document.title})")
                except Exception:
                    continue
                if info and info.get('l', 0) > 5000:
                    html = self._eval(ws, "document.documentElement.outerHTML")
                    ws.close()
                    return html
            ws.close()
        return None

    def close(self):
        if getattr(self, 'proc', None):
            try:
                self.proc.terminate()
            except Exception:
                pass
        self._kill_lingering()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default=None)
    args = ap.parse_args()

    print('=' * 70)
    print('原生 CDP 零注入 — 瑞数挑战 (站点D)')
    print('=' * 70)

    c = CDPClient(headless=True)
    try:
        urls = [args.url] if args.url else [
            base64.b64decode("aHR0cHM6Ly93d3cubm1wYS5nb3YuY24v").decode(),
            base64.b64decode("aHR0cHM6Ly93d3cubm1wYS5nb3YuY24vZGF0YXNlYXJjaC8=").decode(),
            base64.b64decode("aHR0cHM6Ly93d3cubm1wYS5nb3YuY24vZGF0YXNlYXJjaC9zZWFyY2gtcmVzdWx0Lmh0bWw=").decode(),
        ]
        for url in urls:
            print(f'\n─ {url}')
            t0 = time.time()
            html = c.get(url)
            elapsed = time.time() - t0
            if html and len(html) > 5000:
                m = re.search(r'<title>([^<]*)</title>', html)
                print(f"  ✅ PASS  {len(html)}b  {elapsed:.1f}s  {m.group(1).strip()[:50] if m else '?'}")
            else:
                print(f"  ❌ FAIL  {'len=' + str(len(html)) if html else 'None'}  {elapsed:.1f}s")
    finally:
        c.close()

    print('\n完成')


if __name__ == '__main__':
    main()
