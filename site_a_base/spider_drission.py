"""方案 4: DrissionPage — 系统 Chrome 【稳妥但慢】
实测: 5/5 全过, 2-128s/站 (严格站首访挑战耗时 1-2 分钟)

依赖: pip install DrissionPage
运行: python spider_drission.py

注意:
  - run_js 是一次性执行 (只作用在当时的页面), 不会持久注入到挑战页 —
    这正是它能过瑞数的原因; 切勿换成持久化注入 (Page.addScriptToEvaluateOnNewDocument)
  - 系统 Chrome 版本 >151 时注意 UA 与 sec-ch-ua 的版本差异, 实测不影响通过
"""
import sys, re, time, base64

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

from DrissionPage import ChromiumPage, ChromiumOptions

UA138 = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36')

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
    co = ChromiumOptions()
    co.headless(True)
    co.set_user_agent(UA138)
    co.set_argument('--remote-allow-origins=*')
    page = ChromiumPage(co)
    # 一次性注入 (不进挑战页)
    page.run_js('Object.defineProperty(navigator,"webdriver",{get:()=>undefined});'
                'window.chrome={runtime:{}};')

    ok = 0
    for name, url in SITES:
        t0 = time.time()
        try:
            page.get(url)
        except Exception:
            pass
        for _ in range(60):  # 严格站挑战可能 1-2 分钟
            time.sleep(1)
            try:
                if len(page.html) > 5000:
                    break
            except Exception:
                pass
        html = page.html
        size = len(html)
        passed = size > 5000 and not ('$_ts.nsd' in html[:3000] and size < 5000)
        ok += passed
        m = re.search(r'<title>([^<]*)</title>', html)
        print(f'{name}: {"PASS" if passed else "FAIL"} {size}b {time.time()-t0:.0f}s | '
              f'{m.group(1).strip() if m else "?"}')
    page.quit()
    print(f'\ndrission: {ok}/{len(SITES)} 通过')


if __name__ == '__main__':
    main()
