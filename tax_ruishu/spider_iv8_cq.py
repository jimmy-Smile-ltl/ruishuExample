"""
spider_iv8_cq.py — 站点F 同族站（重庆税务）iv8 运行时路线

iv8 = Python 原生 V8 + C++ 层浏览器环境（pip install iv8, 社区版）。
瑞数 VM 在 iv8 里执行出 cookie, 并捕获瑞数 XHR 动态签名 URL。

★ 实测 (2026-09-05, iv8 0.1.4): 一次通过 (用户实测; 与药监局/欧冶同批验证)

链路:
  requests 拿 412 → iv8 page.load 执行 VM → document.cookie 出 P
    → 二次 page.load (带 cookie) → 页面内 XHR 触发瑞数 hook
    → netLog 捕获签名后的 URL + cookie → requests 重放拿数据

依赖: pip install iv8 requests
用法: python spider_iv8_cq.py

改编自 iv8 上游仓库 examples（github.com/HanZzzzz000/iv8, 社区版非商用许可）。
"""
import json
import re
import base64
import urllib.parse

import iv8
import requests

# 目标 URL (base64, 运行时解码)
_B = lambda s: base64.b64decode(s).decode()
PAGE_HREF = _B("aHR0cDovL2Nob25ncWluZy5jaGluYXRheC5nb3YuY246ODg4OC9xeHpmZ3Mvd3oveHpjZi9zd3h6eWJjeGNmamc=")
API_URL = _B("aHR0cDovL2Nob25ncWluZy5jaGluYXRheC5nb3YuY246ODg4OC9hcGkvbG9hZE5ld3NJbmZv")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36")


def build_environment():
    u = urllib.parse.urlsplit(PAGE_HREF)  # location 各字段从目标 URL 派生, 无明文
    return {
        "location": {
            "ancestorOrigins": {},
            "href": PAGE_HREF,
            "origin": u.scheme + "://" + u.netloc,
            "protocol": u.scheme + ":",
            "host": u.netloc,
            "hostname": u.hostname,
            "port": str(u.port or ""),
            "pathname": u.path,
            "search": "",
            "hash": ""
        },
        "navigator": {"userAgent": UA}
    }


def load_round(ctx, session, headers, page_url, resp):
    """一轮 page.load: 预取 VM js 注入 resources, 离线解析"""
    js_match = re.search(r'src="([^"]+\.js)"[^>]*r=\'m\'', resp.text)
    js_url = urllib.parse.urljoin(page_url, js_match.group(1))
    js_code = session.get(js_url, headers=headers, cookies=session.cookies.get_dict()).text
    ctx.expose({
        "baseURL": page_url, "html": resp.text,
        "headers": [[k, v] for k, v in resp.raw.headers.items()],
        "resources": {js_url: js_code},
    }, "snap")
    ctx.eval("window.__iv8__.page.load(window.__iv8__.data.snap)")
    ctx.eval("window.__iv8__.eventLoop.sleep(100)")


def main():
    # data 参数: checkVerifyCode 为验证码占位 (示例值, 实际使用时需接入验证码)
    data = {"twolm": "swxzybcxcfjg", "siteCode": "wz", "rows": "15",
            "input1": "123", "checkVerifyCode": "5905"}
    headers = {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Origin": build_environment()["location"]["origin"],
        "Referer": PAGE_HREF,
        "User-Agent": UA,
        "X-Requested-With": "XMLHttpRequest",
    }
    session = requests.Session()

    with iv8.JSContext(environment=build_environment(),
                       config={"timezone": "Asia/Shanghai"}) as ctx:
        # 1. 首次请求 → 瑞数种 cookie
        resp1 = session.get(PAGE_HREF, headers=headers)
        print(f"首次请求: {resp1.status_code}")
        load_round(ctx, session, headers, PAGE_HREF, resp1)
        cookies_str = ctx.eval('document.cookie')
        print(f"  [iv8] cookie {len(cookies_str)}c")

        # 2. 携 cookie 重载 → 拿到带 XHR hook 的页面
        resp2 = session.get(PAGE_HREF, headers={**headers, "Cookie": cookies_str})
        print(f"第二次请求: {resp2.status_code}")
        load_round(ctx, session, headers, PAGE_HREF, resp2)

        # 3. 页面内 XHR 触发瑞数 hook → netLog 捕获签名 URL
        body_str = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
        ctx.eval(f"""
            var xhr = new XMLHttpRequest();
            xhr.open('POST', '{API_URL}');
            xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
            xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
            xhr.send('{body_str}');
        """)
        entry = ctx.eval("window.__iv8__.netLog.entries[window.__iv8__.netLog.entries.length - 1]")
        if not entry:
            print("未找到请求"); return
        print(f"  签名 URL: {entry['url'][:80]}...")

        # 4. 用签名 URL + cookie 重放
        final_cookie = entry.get('cookieHeader') or cookies_str
        api_url = entry['url'] if entry['url'].startswith('http') \
            else build_environment()["location"]["origin"] + entry['url']
        resp = requests.post(api_url, data=data, headers={**headers, "Cookie": final_cookie})
        print(f"状态码: {resp.status_code}")
        print(resp.text[:300])


if __name__ == "__main__":
    main()
