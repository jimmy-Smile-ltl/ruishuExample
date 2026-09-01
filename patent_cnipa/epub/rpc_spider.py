"""
rpc_spider.py — 专利公布公告 CDP RPC 爬虫 — 真实 Chrome 页面内翻页 (生产方案)

架构 (pro11 药监局 RPC 同款, 2026-08-15):
  真实 Chrome (headless=new, 零注入, UA138, 持久 profile)
    ├─ 瑞数挑战由浏览器原生通过 (免逆向)
    ├─ 页面内 fill 搜索框 → submit indexForm → 结果页
    ├─ 翻页点击分页组件「下页」按钮
    │    └─ 瑞数动态 token 由页面 XHR hook 自动附加
    └─ Runtime.evaluate 提取 #result 条目为 JSON

为什么不用纯 curl: /Dxb/PageQuery 翻页 AJAX 需要瑞数动态 token,
纯算逆向成本高。curl + sdenv 链式可过挑战拿首页/搜索结果页 (spider_sdenv.py),
但翻页 AJAX 必须走页面内 (token 自动生成)。

用法:
    python rpc_spider.py 石墨烯
    python rpc_spider.py 石墨烯 --max-pages 5
    python rpc_spider.py 石墨烯 --max-pages 100 --pace 1.5
"""
import sys
import json
import time
import random
import shutil
import base64
import argparse
import subprocess
import urllib.request
from pathlib import Path

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

PROJ = Path(__file__).parent
import websocket as wslib  # noqa: E402

# 目标 URL (base64, 运行时解码)
BASE = base64.b64decode("aHR0cDovL2VwdWIuY25pcGEuZ292LmNu").decode()
CACHE_DIR = PROJ / 'output' / 'rpc_cache'
CACHE_DIR.mkdir(parents=True, exist_ok=True)
PROFILE = CACHE_DIR / 'cdp_profile_epub'
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
OUT = PROJ / 'output'
UA138 = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36')

EXTRACT_JS = r"""
JSON.stringify(Array.from(document.querySelectorAll('#result .item')).map(function(item){
  var out = {};
  var t = item.querySelector('h1.title');
  if (t) { var tt = t.innerText.trim(); var m = tt.match(/^\[([^\]]*)\]\s*(.*)$/);
    out['类型'] = m ? m[1] : ''; out['标题'] = (m ? m[2] : tt).trim(); }
  item.querySelectorAll('dl').forEach(function(dl){
    var dt = dl.querySelector('dt'), dd = dl.querySelector('dd');
    if (dt && dd) out[dt.innerText.trim().replace('：','')] = dd.innerText.trim();
  });
  var qr = item.querySelector('.qrcode');
  if (qr) out['公布号'] = qr.id;
  return out;
}))"""


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


class EpubRPC:
    def __init__(self, fresh=False, pace=0.8):
        self.pace = pace
        self.port = random.randint(20000, 45000)
        self.profile = PROFILE.resolve()
        self._launch(fresh)

    # ── Chrome 生命周期 ──────────────────────────────────────
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

    def _launch(self, fresh):
        if fresh and self.profile.exists():
            shutil.rmtree(self.profile, ignore_errors=True)
        self._kill_lingering()
        args = [CHROME, f'--remote-debugging-port={self.port}',
                '--remote-allow-origins=*', f'--user-data-dir={self.profile}',
                '--no-first-run', '--no-default-browser-check',
                f'--user-agent={UA138}', '--headless=new', 'about:blank']
        errf = open(str(CACHE_DIR / 'chrome_err_epub.log'), 'w', encoding='utf-8', errors='replace')
        subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=errf)
        # Chrome 151 提权会话自降权重启较慢, 等待端口 (最长 90s)
        for _ in range(180):
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{self.port}/json/version', timeout=1)
                return
            except Exception:
                time.sleep(0.5)
        raise RuntimeError('Chrome did not start')

    def connect(self):
        req = urllib.request.Request(
            f'http://127.0.0.1:{self.port}/json/new?about:blank', method='PUT')
        tab = json.loads(urllib.request.urlopen(req, timeout=5).read().decode('utf-8', errors='replace'))
        self.ws = wslib.create_connection(tab['webSocketDebuggerUrl'], timeout=30)
        self._mid = 0
        self._cmd('Page.enable')
        self._cmd('Runtime.enable')
        self._cmd('Network.enable')
        self.ws.settimeout(0.5)

    def _cmd(self, method, params=None):
        self._mid += 1
        self.ws.send(json.dumps({'id': self._mid, 'method': method, 'params': params or {}}))
        while True:
            try:
                msg = json.loads(self.ws.recv())
            except wslib.WebSocketTimeoutException:
                continue
            if isinstance(msg.get('id'), int) and msg['id'] == self._mid:
                return msg.get('result', {})

    def _eval(self, expr, await_promise=False, timeout=30):
        t0 = time.time()
        self._mid += 1
        self.ws.send(json.dumps({'id': self._mid, 'method': 'Runtime.evaluate',
                                 'params': {'expression': expr, 'returnByValue': True,
                                            'awaitPromise': await_promise}}))
        while True:
            try:
                msg = json.loads(self.ws.recv())
            except wslib.WebSocketTimeoutException:
                if time.time() - t0 > timeout:
                    return None
                continue
            if isinstance(msg.get('id'), int) and msg['id'] == self._mid:
                r = msg.get('result', {})
                if 'exceptionDetails' in r:
                    return None
                return r.get('result', {}).get('value')

    # ── 页面流程 ────────────────────────────────────────────
    def open_site(self, url=BASE + '/', wait=90):
        self._eval(f'location.href = {json.dumps(url)}')
        t0 = time.time()
        while time.time() - t0 < wait:
            v = self._eval('!!document.getElementById("searchStr")')
            if v:
                log(f'首页挑战通过 ({time.time()-t0:.1f}s)')
                return True
            time.sleep(1.5)
        return False

    def search(self, keyword, wait=60):
        """填关键词 + 提交 indexForm"""
        self._eval(f"var i=document.getElementById('searchStr'); i.focus(); i.value='';")
        time.sleep(0.3)
        self._mid += 1
        self.ws.send(json.dumps({'id': self._mid, 'method': 'Input.insertText',
                                 'params': {'text': keyword}}))
        # 读掉响应
        while True:
            try:
                msg = json.loads(self.ws.recv())
            except wslib.WebSocketTimeoutException:
                continue
            if isinstance(msg.get('id'), int) and msg['id'] == self._mid:
                break
        time.sleep(0.3)
        self._eval("document.getElementById('indexForm').submit(); 'ok'")
        t0 = time.time()
        while time.time() - t0 < wait:
            v = self._eval("document.getElementById('result') && "
                           "document.getElementById('result').querySelector('.item') ? "
                           "document.getElementById('result').innerHTML.length : 0")
            if v and v > 5000:
                log(f'搜索结果加载 ({time.time()-t0:.1f}s)')
                return True
            time.sleep(1.5)
        return False

    def _wait_ajax(self, timeout=30):
        """等 #result 内容更新完成 (必须先观察到变化, 再等稳定)"""
        t0 = time.time()
        last_len = self._eval("document.getElementById('result') ? "
                              "document.getElementById('result').innerHTML.length : 0") or 0
        changed = False
        while time.time() - t0 < timeout:
            time.sleep(1)
            cur = self._eval("document.getElementById('result') ? "
                             "document.getElementById('result').innerHTML.length : 0") or 0
            if cur != last_len and cur > 0:
                changed = True
                last_len = cur
            elif changed:
                return True
        return changed

    def to_page(self, page_num):
        """翻页: 点击分页组件的「下页」按钮 (实测点击路径比直接调
        to_page() 可靠 — 直接调用偶发 WAF 400, 点击路径连续 200)。

        若目标页 > 当前页+1 (400 失步后), 先回拨 pageNum 再用
        next_page 顺序推进。"""
        cur = int(self._eval("$('#pageNum').val()") or 0)
        if cur >= page_num:
            # 状态失步: 回拨
            self._eval(f"$('#pageNum').val({page_num - 1}); 'ok'")
            cur = page_num - 1
        for _ in range(page_num - cur):
            r = self._eval(
                "(function(){var b=document.querySelector('.topage .next_page, "
                ".page_ctrl .next_page'); if(!b) return 0; "
                "if(b.getAttribute('disabled')) return -1; b.click(); return 1;})()")
            if r != 1:
                return False
            if not self._wait_ajax():
                return False
        return True

    def extract_items(self):
        v = self._eval(EXTRACT_JS)
        if not v:
            return []
        try:
            return json.loads(v)
        except Exception:
            return []

    def total_info(self):
        v = self._eval("JSON.stringify({total: (window.total_page || 0), "
                       "cur: $('#pageNum').val(), per: $('#pageSize').val()})")
        try:
            return json.loads(v)
        except Exception:
            return {}

    # ── 主流程 ─────────────────────────────────────────────
    def run(self, keyword, max_pages=None, out_dir=None):
        out_dir = out_dir or (OUT / keyword)
        out_dir.mkdir(parents=True, exist_ok=True)
        ckpt = out_dir / '_checkpoint.json'
        ckpt_data = json.loads(ckpt.read_text(encoding='utf-8')) if ckpt.exists() else {}

        self.connect()
        if not self.open_site():
            raise RuntimeError('首页挑战未通过')
        if not self.search(keyword):
            raise RuntimeError('搜索结果未加载')

        info = self.total_info()
        total = info.get('total', 0)
        per = int(info.get('per') or 3)
        total_pages = max(1, -(-total // per))
        if max_pages:
            total_pages = min(total_pages, max_pages)
        log(f"'{keyword}': 共 {total} 条, 爬 {total_pages} 页 (每页 {per})")

        all_items = []
        for pg in range(1, total_pages + 1):
            if str(pg) in ckpt_data:
                log(f"  第 {pg} 页: 断点跳过")
                continue
            if pg > 1:
                ok = self.to_page(pg)
                if not ok:
                    # WAF 间歇 400 (10.2s 拖慢拒绝), 重试一次
                    log(f"  第 {pg} 页: 400/超时, 12s 后重试")
                    time.sleep(12)
                    ok = self.to_page(pg)
                cur_pg = self._eval("$('#pageNum').val()")
                if not ok or str(cur_pg) != str(pg):
                    log(f"  第 {pg} 页: 重试仍失败 (cur={cur_pg}), 停")
                    break
            items = self.extract_items()
            if not items:
                log(f"  第 {pg} 页: 无条目, 停")
                break
            all_items.extend(items)
            (out_dir / f'page_{pg}.json').write_text(
                json.dumps(items, indent=2, ensure_ascii=False), encoding='utf-8')
            ckpt_data[str(pg)] = len(items)
            ckpt.write_text(json.dumps(ckpt_data, ensure_ascii=False), encoding='utf-8')
            log(f"  第 {pg}/{total_pages} 页: {len(items)} 条  "
                f"(首: {items[0].get('标题','')[:22]})")
            if pg < total_pages:
                time.sleep(self.pace)

        (out_dir / 'all.json').write_text(
            json.dumps(all_items, indent=2, ensure_ascii=False), encoding='utf-8')
        log(f"[DONE] '{keyword}': {len(all_items)} 条 → {out_dir}")
        return all_items

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass
        self._kill_lingering()


def main():
    ap = argparse.ArgumentParser(description='专利公布公告 RPC 爬虫')
    ap.add_argument('keyword')
    ap.add_argument('--max-pages', type=int, default=None)
    ap.add_argument('--pace', type=float, default=0.8, help='翻页间隔秒')
    ap.add_argument('--fresh', action='store_true', help='全新浏览器 profile')
    args = ap.parse_args()

    rpc = EpubRPC(fresh=args.fresh, pace=args.pace)
    try:
        rpc.run(args.keyword, max_pages=args.max_pages)
    finally:
        rpc.close()


if __name__ == '__main__':
    main()
