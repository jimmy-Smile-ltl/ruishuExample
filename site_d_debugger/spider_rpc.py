"""
spider_rpc.py — RPC 数据查询爬虫 (页面内直达 pajax 调用, 站点D 示例)

架构 (2026-08-13 定版, 自包含版):
  真实 Chrome (headless, 持久 profile, 零注入, 可选代理)
    └─ 页面内直接调用 pajax.hasTokenGet(api.queryList, {...})
       └─ 7QBHXKaZ 签名由页面 token 层自动生成, 无需逆向
       └─ Runtime.evaluate + awaitPromise 直接返回 JSON (0.2s/页)

  翻页: 直接改 pageNum 参数 (实测: 阿莫西林 572 条/58 页全通)

WAF 限流: 每会话 ~25 次 API 后失败 → pace≥1.2s + 每 ~20 页换 profile/代理节点
         (--fresh 换新 profile, --proxy 换 Clash 出口 IP) + 15-30min 冷却

依赖:
  pip install websocket-client    # psutil 可选 (清理残留 Chrome 进程用)

用法:
    python spider_rpc.py 阿莫西林 青霉素 布洛芬
    python spider_rpc.py --file keywords.txt
    python spider_rpc.py 阿莫西林 --max-pages 3 --fresh --proxy http://127.0.0.1:7897
"""
import sys
import json
import time
import math
import random
import shutil
import argparse
import base64
import subprocess
import urllib.request
from pathlib import Path

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

B = base64.b64decode("aHR0cHM6Ly93d3cubm1wYS5nb3YuY24=").decode()
HERE = Path(__file__).parent
OUT = HERE / 'output' / 'rpc_data'
OUT.mkdir(parents=True, exist_ok=True)
PROFILE = (HERE / 'rpc_profile').resolve()
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
UA138 = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36')

# 境内生产药品 (item_2); 其他分类 itemId 见数据查询页配置
DEFAULT_ITEM_ID = 'ff80808183cad75001840881f848179f'

API_EXPR = '''(function(){
  return pajax.hasTokenGet(api.queryList, %s)
    .then(function(r){
      var d = r && r.data && r.data.data;
      if (!d) return JSON.stringify({err: 'no-data', raw: JSON.stringify(r).slice(0,200)});
      return JSON.stringify({total: d.total, pageSize: d.pageSize, list: d.list});
    })
    .catch(function(e){ return JSON.stringify({err: e.message}); });
})()'''


class ChromeCDP:
    """真实 Chrome 零注入 CDP 客户端 (自包含, 无外部依赖)"""

    def __init__(self, keep_profile=True, proxy=None):
        self.port = random.randint(20000, 45000)
        self.profile = PROFILE
        self.proxy = proxy
        self._mid = 0
        self._launch(keep_profile)

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

    def _launch(self, keep_profile):
        self._kill_lingering()
        if not keep_profile and self.profile.exists():
            shutil.rmtree(self.profile, ignore_errors=True)
        args = [CHROME, f'--remote-debugging-port={self.port}',
                '--remote-allow-origins=*', f'--user-data-dir={self.profile}',
                '--no-first-run', '--no-default-browser-check',
                f'--user-agent={UA138}', '--headless=new']
        if self.proxy:
            args.append(f'--proxy-server={self.proxy}')
        args.append('about:blank')
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{self.port}/json/version', timeout=1)
                return
            except Exception:
                time.sleep(0.5)
        raise RuntimeError('Chrome did not start')

    def close(self):
        if getattr(self, 'proc', None):
            try:
                self.proc.terminate()
            except Exception:
                pass
        self._kill_lingering()


class NmpaRPC:
    def __init__(self, verbose=True, fresh=False, pace=1.2, proxy=None):
        self.verbose = verbose
        self.pace = pace
        self.c = ChromeCDP(keep_profile=not fresh, proxy=proxy)
        self.ws = None
        self.tab = None
        self._mid = 0
        self._last_call = 0.0

    def log(self, msg):
        if self.verbose:
            print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

    def _connect(self):
        req = urllib.request.Request(
            f'http://127.0.0.1:{self.c.port}/json/new?about:blank', method='PUT')
        self.tab = json.loads(urllib.request.urlopen(req, timeout=5).read().decode('utf-8', errors='replace'))
        import websocket as wslib
        self.ws = wslib.create_connection(self.tab['webSocketDebuggerUrl'], timeout=30)
        self._cmd('Page.enable')
        self._cmd('Runtime.enable')
        self._cmd('Network.enable')

    def _ensure_ws(self):
        try:
            self.ws.send(json.dumps({'id': 999999, 'method': 'Runtime.evaluate',
                                     'params': {'expression': '1'}}))
            return True
        except Exception:
            pass
        try:
            self.ws.close()
        except Exception:
            pass
        try:
            import websocket as wslib
            self.ws = wslib.create_connection(self.tab['webSocketDebuggerUrl'], timeout=30)
            self._cmd('Page.enable')
            self._cmd('Runtime.enable')
            self._cmd('Network.enable')
            return True
        except Exception:
            return False

    def _cmd(self, method, params=None, timeout=15):
        self._mid += 1
        mid = self._mid
        self.ws.send(json.dumps({'id': mid, 'method': method, 'params': params or {}}))
        self.ws.settimeout(0.2)
        t0 = time.time()
        while time.time() - t0 < timeout:
            import websocket as wslib
            try:
                msg = json.loads(self.ws.recv())
            except wslib.WebSocketTimeoutException:
                continue
            except Exception:
                raise ConnectionError('ws closed')
            if msg.get('id') == mid:
                if 'error' in msg:
                    raise RuntimeError(f'{method}: {msg["error"]}')
                return msg.get('result', {})
        raise TimeoutError(f'{method} 无响应')

    def _eval(self, expr, timeout=10):
        r = self._cmd('Runtime.evaluate', {'expression': expr, 'returnByValue': True}, timeout=timeout)
        v = r.get('result', {})
        if v.get('subtype') == 'error':
            return None
        return v.get('value')

    def _eval_promise(self, expr, timeout=20):
        r = self._cmd('Runtime.evaluate',
                      {'expression': expr, 'returnByValue': True, 'awaitPromise': True},
                      timeout=timeout)
        v = r.get('result', {})
        if v.get('subtype') == 'error':
            raise RuntimeError(v.get('description', 'eval error'))
        return v.get('value')

    def _goto(self):
        self._cmd('Runtime.evaluate',
                  {'expression': f"location.href = {json.dumps(B + '/datasearch/')}"})

    def start(self):
        self._connect()
        self._goto()
        t0 = time.time()
        while time.time() - t0 < 120:
            time.sleep(2)
            try:
                self._ensure_ws()
                state = self._eval("({l: document.documentElement.outerHTML.length})")
                if state and state.get('l', 0) < 100:
                    self._goto()
                    continue
                if self._eval("(typeof pajax === 'object' && typeof api === 'object') ? 'READY' : null"):
                    self.log('页面就绪 (pajax + api 可用)')
                    return self
            except Exception:
                pass
        raise RuntimeError('页面未就绪')

    def query(self, search_value, page_num=1, page_size=10, item_id=DEFAULT_ITEM_ID,
              is_senior='N', search_param='', order_param=''):
        wait = self._last_call + self.pace - time.time()
        if wait > 0:
            time.sleep(wait)
        params = {
            'itemId': item_id,
            'isSenior': is_senior,
            'searchValue': search_value,
            'pageNum': page_num,
            'pageSize': page_size,
        }
        if is_senior == 'Y':
            params['searchParam'] = search_param
            params['orderParam'] = order_param
        self._ensure_ws()
        self._last_call = time.time()
        val = self._eval_promise(API_EXPR % json.dumps(params, ensure_ascii=False))
        if val is None:
            raise RuntimeError('eval 无返回')
        obj = json.loads(val)
        if 'err' in obj:
            raise RuntimeError(obj['err'])
        return obj

    def recover(self):
        self.log('  恢复: 重载页面 ...')
        self._ensure_ws()
        self._goto()
        t0 = time.time()
        while time.time() - t0 < 90:
            time.sleep(2)
            try:
                if self._eval("(typeof pajax === 'object' && typeof api === 'object') ? 'READY' : null"):
                    self.log('  页面已恢复')
                    return True
            except Exception:
                self._ensure_ws()
        return False

    def crawl_keyword(self, keyword, max_pages=0, item_id=DEFAULT_ITEM_ID, max_recover=2):
        first = self.query(keyword, 1, 10, item_id)
        items = list(first['list'])
        total = first['total']
        pages = math.ceil(total / 10) if total else 1
        if max_pages:
            pages = min(pages, max_pages)
        self.log(f'  第1页: {len(items)} 条, 共 {total} 条, 目标 {pages} 页')
        recovers = 0
        for p in range(2, pages + 1):
            try:
                obj = self.query(keyword, p, 10, item_id)
            except Exception as e:
                self.log(f'  第{p}页失败: {e}')
                if recovers < max_recover and self.recover():
                    recovers += 1
                    time.sleep(self.pace)
                    try:
                        obj = self.query(keyword, p, 10, item_id)
                    except Exception as e2:
                        self.log(f'  第{p}页恢复后仍失败: {e2}, 停止')
                        break
                else:
                    self.log('  恢复失败, 停止')
                    break
            its = obj.get('list') or []
            if not its:
                self.log(f'  第{p}页空, 停止')
                break
            seen = {i.get('f4') for i in items}
            new = [i for i in its if i.get('f4') not in seen]
            items.extend(new)
            if p % 20 == 0 or p == pages:
                self.log(f'  第{p}/{pages}页: +{len(new)} 条, 累计 {len(items)}')
        return items

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass
        self.c.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('keywords', nargs='*')
    ap.add_argument('--file', help='关键词文件 (每行一个)')
    ap.add_argument('--max-pages', type=int, default=0, help='每关键词最多抓 N 页 (0=全量)')
    ap.add_argument('--item-id', default=DEFAULT_ITEM_ID, help='数据分类 itemId')
    ap.add_argument('--fresh', action='store_true', help='全新浏览器 profile (会话被标记时用)')
    ap.add_argument('--pace', type=float, default=1.2, help='请求间隔秒数 (默认1.2, 过快触发WAF标记)')
    ap.add_argument('--proxy', default=None, help='浏览器代理 (如 http://127.0.0.1:7897, 换出口IP用)')
    args = ap.parse_args()

    keywords = list(args.keywords)
    if args.file:
        keywords += [l.strip() for l in open(args.file, encoding='utf-8') if l.strip()]
    if not keywords:
        print('用法: python spider_rpc.py 阿莫西林 青霉素 [--file kw.txt] [--max-pages N]')
        sys.exit(1)

    print('=' * 70)
    print(f'RPC 数据查询 — {len(keywords)} 个关键词')
    print('=' * 70)

    rpc = NmpaRPC(fresh=args.fresh, pace=args.pace, proxy=args.proxy)
    try:
        rpc.start()
        for kw in keywords:
            t0 = time.time()
            try:
                items = rpc.crawl_keyword(kw, max_pages=args.max_pages, item_id=args.item_id)
            except Exception as e:
                print(f'  [ERROR] {kw}: {e}')
                items = []
            elapsed = time.time() - t0
            if items:
                fn = OUT / f'{kw}.json'
                fn.write_text(json.dumps(
                    {'keyword': kw, 'total': len(items), 'items': items},
                    ensure_ascii=False, indent=1), encoding='utf-8')
                print(f'  ✅ {kw}: {len(items)} 条 ({elapsed:.1f}s) → {fn}')
    finally:
        rpc.close()
    print('\n完成')


if __name__ == '__main__':
    main()
