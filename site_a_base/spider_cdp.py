"""方案 2: CDP 直连真实 Chrome — 零注入配方 【Chrome 系首选】
实测: 5/5 全过, 1-5s/站 (2026-08-13, pro36 五所大学瑞数)

配方四要素 (缺一不可):
  1. 真实 chrome.exe + --headless=new — TLS/HTTP2 指纹天然可信, 无自动化标志
  2. --user-agent=Chrome/138 — 与站点风控规则收录的版本对齐
  3. 零 JS 注入 — 任何 stealth 注入 (addScriptToEvaluateOnNewDocument) 都会
     改 navigator 属性描述符, 被瑞数 VM 检测 → 静默放弃出 cookie → 重载被 400
  4. renderer 跳转 (location.href) 发起导航, 不用 Page.navigate

依赖: pip install websocket-client
运行: python spider_cdp.py
注意: 本机 Chrome 137+ 在提权会话下会自我降权重启 (父进程退出码 0 属正常),
     启动检测只信调试端口; --user-data-dir 必须是绝对路径。
"""
import sys, re, time, json, random, subprocess, urllib.request, base64
from pathlib import Path

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

import websocket

CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
UA138 = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36')
PROFILE = (Path(__file__).parent / 'cdp_profile').resolve()

def _b64(s):
    """目标 URL 匿名化存储 (base64)"""
    return base64.b64decode(s).decode()


SITES = [
    ('高校1', _b64('aHR0cHM6Ly93d3cubHp1LmVkdS5jbg==')),
    ('高校2', _b64('aHR0cHM6Ly93d3cuc2N1LmVkdS5jbg==')),
    ('高校3', _b64('aHR0cHM6Ly93d3cuYnVwdC5lZHUuY24=')),
    ('高校4', _b64('aHR0cHM6Ly93d3cubmpudS5lZHUuY24=')),
    ('高校5', _b64('aHR0cHM6Ly93d3cubmp1c3QuZWR1LmNu')),
]


class CdpClient:
    def __init__(self, port=None):
        self.port = port or random.randint(20000, 45000)
        self._launch()

    def _launch(self):
        args = [CHROME, '--headless=new', f'--remote-debugging-port={self.port}',
                '--remote-allow-origins=*', f'--user-data-dir={PROFILE}',
                '--no-first-run', '--no-default-browser-check',
                f'--user-agent={UA138}', 'about:blank']
        subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):  # 只信端口, 不信进程退出 (提权会话下父进程会自我降权退出)
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{self.port}/json/version', timeout=1)
                return
            except Exception:
                time.sleep(0.5)
        raise RuntimeError('Chrome 未就绪')

    def _cmd(self, ws, method, params=None):
        self._mid = getattr(self, '_mid', 0) + 1
        ws.send(json.dumps({'id': self._mid, 'method': method, 'params': params or {}}))
        while True:
            try:
                msg = json.loads(ws.recv())
            except websocket.WebSocketTimeoutException:
                continue
            if msg.get('id') == self._mid:
                if 'error' in msg:
                    raise RuntimeError(msg['error'])
                return msg.get('result', {})

    def _eval(self, ws, expr):
        r = self._cmd(ws, 'Runtime.evaluate', {'expression': expr, 'returnByValue': True})
        v = r.get('result', {})
        if v.get('subtype') == 'error':
            raise RuntimeError(v.get('description', ''))
        return v.get('value')

    def get(self, url, max_retries=2):
        for attempt in range(max_retries):
            # 新建 tab → renderer 跳转 (关键: 不用 Page.navigate)
            req = urllib.request.Request(
                f'http://127.0.0.1:{self.port}/json/new?about:blank', method='PUT')
            tab = json.loads(urllib.request.urlopen(req, timeout=5).read().decode())
            ws = websocket.create_connection(tab['webSocketDebuggerUrl'], timeout=30)
            self._cmd(ws, 'Page.enable')
            self._cmd(ws, 'Runtime.enable')
            self._eval(ws, f'location.href = {json.dumps(url)}')

            t0 = time.time()
            while time.time() - t0 < 40:  # 等 412 → VM → cookie → 重载 → 200
                time.sleep(1)
                try:
                    info = self._eval(ws, "({l: document.documentElement.outerHTML.length,"
                                          " t: document.title})")
                except Exception:
                    continue
                if info and info.get('l', 0) > 5000:
                    try:
                        html = self._eval(ws, 'document.documentElement.outerHTML')
                    except Exception:
                        html = None
                    ws.close()
                    return html
            ws.close()  # 首访挑战偶发未完成 → 换新 tab 重试
        return None


def main():
    cdp = CdpClient()
    ok = 0
    for name, url in SITES:
        t0 = time.time()
        html = cdp.get(url)
        size = len(html) if html else 0
        passed = size > 5000
        ok += passed
        m = re.search(r'<title>([^<]*)</title>', html or '')
        print(f'{name}: {"PASS" if passed else "FAIL"} {size}b {time.time()-t0:.0f}s | '
              f'{m.group(1).strip() if m else "?"}')
        time.sleep(1)
    print(f'\ncdp: {ok}/{len(SITES)} 通过')


if __name__ == '__main__':
    main()
