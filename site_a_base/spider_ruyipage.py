"""方案 1: ruyiPage — Firefox + WebDriver BiDi 反检测框架 【首选】
实测: 5/5 全过, 2-3s/站 (2026-08-13, pro36 五所大学瑞数)

特性:
  - Firefox 内核 + WebDriver BiDi 协议 (非 CDP), isTrusted 原生事件
  - 每 tab 一个密码代理 — 直接解决瑞数 IP 风控的节点轮换问题
  - 内置 handle_cloudflare_challenge / closed shadow root 访问
  - 提权会话自动处理 system access

依赖: pip install ruyiPage && python -m ruyipage install
  (install 若因 Defender 锁文件报 PermissionError, 手动解压 release zip 到
   %LOCALAPPDATA%\\ruyipage\\browsers\\firefox-155.0a1-v1.2.58-win64\\
   注意保留 zip 内自带的 firefox 子目录结构)

运行: python spider_ruyipage.py [--proxy http://127.0.0.1:7890] [--headless]
"""
import sys, time, argparse, base64

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

from ruyipage import launch

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
    ap = argparse.ArgumentParser()
    ap.add_argument('--proxy', default=None, help='每 tab 独立代理, 如 http://127.0.0.1:7890')
    ap.add_argument('--headless', action='store_true')
    args = ap.parse_args()

    page = launch(headless=args.headless, proxy=args.proxy)
    ok = 0
    for name, url in SITES:
        t0 = time.time()
        try:
            page.get(url, timeout=30)
        except Exception:
            pass
        for _ in range(30):  # 等瑞数挑战完成 (412 → VM → cookie → 重载 → 200)
            time.sleep(1)
            try:
                if len(page.html or '') > 5000:
                    break
            except Exception:
                pass
        size = len(page.html or '')
        passed = size > 5000
        ok += passed
        print(f'{name}: {"PASS" if passed else "FAIL"} {size}b {time.time()-t0:.0f}s | {page.title}')
        time.sleep(1)
    page.quit()
    print(f'\nruyipage: {ok}/{len(SITES)} 通过')


if __name__ == '__main__':
    main()
