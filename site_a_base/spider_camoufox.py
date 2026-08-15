"""方案 3: Camoufox — Firefox 反检测内核 【备胎】
实测: 5/5 全过 (干净出口节点), 2-10s/站 (2026-08-13, pro36 五所大学瑞数)

依赖: pip install camoufox && python -m camoufox fetch
运行: python spider_camoufox.py

注意:
  1. 必须用 with 上下文 — Camoufox(...).__enter__() 才返回 browser 对象,
     直接 browser = Camoufox(...) 会报 'new_page' 属性错误
  2. 不注入任何 stealth JS (原生反检测已够, 注入反而破坏瑞数 VM)
  3. 出口节点 IP 被站点标记时 (高校4/高校5 这类 IP 风控站) 会失败,
     切换 Clash 节点重试即可恢复
"""
import sys, time, base64

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

from camoufox.sync_api import Camoufox

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


def main():
    ok = 0
    with Camoufox(headless=False, humanize=True) as browser:
        page = browser.new_page()
        for name, url in SITES:
            t0 = time.time()
            try:
                page.goto(url, timeout=30000, wait_until='domcontentloaded')
            except Exception:
                pass
            size = 0
            for _ in range(30):  # 等瑞数挑战完成
                time.sleep(1)
                try:
                    size = len(page.content())
                    if size > 5000:
                        break
                except Exception:
                    pass
            passed = size > 5000
            ok += passed
            try:
                title = page.title()
            except Exception:
                title = '?'
            print(f'{name}: {"PASS" if passed else "FAIL"} {size}b {time.time()-t0:.0f}s | {title[:30]}')
            time.sleep(1)
    print(f'\ncamoufox: {ok}/{len(SITES)} 通过')


if __name__ == '__main__':
    main()
