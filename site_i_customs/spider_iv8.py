"""
spider_iv8.py — 站点I（海关信用系统）iv8 运行时路线（❌ 失败归档，两层根因已定位）

iv8 = Python 原生 V8 + C++ 层浏览器环境（pip install iv8, 社区版）。

★ 状态 (2026-09-05, iv8 0.1.4): ❌ 未通 —— P-cookie 成形 (343c, act_ 前缀, 与高校组同族)
  但回放恒 412。同批验证的税务/药监/欧冶三站 iv8 一次通过, 海关是 iv8 已知边界样本。

两层根因 (详见 README.md):
  第一层 (已修复): 海关是 http:// 明文站, 但 O/P cookie 带 `; Secure` 属性。真 Chrome
    在非 https 页忽略 Secure 照存 (RFC 6265bis §5.3), iv8 0.1.4 直接丢弃整个 cookie
    → document.cookie 空 → 412。修复 = hook_strip_secure.js 剥 Secure + Set-Cookie
    头剥 Secure + 读完整 jar。
  第二层 (未修复): P 成形后仍 412 拒收 —— P 密码学内容无效, 属于该站 VM 变体的
    深层环境对齐问题 (同高校组"8 处环境差异"类), 需专门对齐, 超出 demo 范畴。

用法 (诊断复现): python spider_iv8.py
依赖: pip install iv8 requests

改编自 iv8 上游仓库 examples（github.com/HanZzzzz000/iv8, 社区版非商用许可）。
"""
import json
import re
import base64
import urllib.parse
from pathlib import Path

import iv8
import requests

# 目标 URL (base64, 运行时解码)
_B = lambda s: base64.b64decode(s).decode()
PAGE_HREF = _B("aHR0cDovL2NyZWRpdC5jdXN0b21zLmdvdi5jbi9jY3Bwd2Vic2VydmVyL3BhZ2VzL2NjcHAvaHRtbC9kaXJlY3RvcnkuaHRtbA==")
API_URL = _B("aHR0cDovL2NyZWRpdC5jdXN0b21zLmdvdi5jbi9jY3Bwc2VydmVyL2NjcHAvcXVlcnlMaXN0")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36")

HOOK = Path(__file__).parent / "hook_strip_secure.js"


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


def strip_secure(headers_iter):
    """响应头列表化: 保留重复 Set-Cookie, 剥离 http 页上的 Secure (对齐真 Chrome)"""
    out = []
    for k, v in headers_iter:
        out.append([k, re.sub(r';\s*secure\b', '', v, flags=re.I)
                    if k.lower() == 'set-cookie' else v])
    return out


def main():
    data = {"manaType": "0", "apanage": "", "depCodeChg": "",
            "curPage": "1", "pageSize": 20}
    headers = {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/json; charset=UTF-8",
        "Origin": build_environment()["location"]["origin"],
        "Referer": PAGE_HREF,
        "User-Agent": UA,
        "X-Requested-With": "XMLHttpRequest",
    }
    session = requests.Session()

    with iv8.JSContext(environment=build_environment(),
                       config={"timezone": "Asia/Shanghai"}) as ctx:
        # 修复 1: 剥 Secure (真 Chrome 在 http 页忽略 Secure, iv8 0.1.4 会丢整个 cookie)
        ctx.eval(HOOK.read_text(encoding='utf-8'))

        # 1. 首次请求
        resp1 = session.get(PAGE_HREF, headers=headers)
        print(f"首次请求: {resp1.status_code}")

        js_match = re.search(r'src="([^"]+\.js)"[^>]*r=\'m\'', resp1.text)
        js_url = urllib.parse.urljoin(PAGE_HREF, js_match.group(1))
        js_code = session.get(js_url, headers=headers,
                              cookies=session.cookies.get_dict()).text

        ctx.expose({
            "baseURL": PAGE_HREF, "html": resp1.text,
            "headers": strip_secure(resp1.raw.headers.items()),
            "resources": {js_url: js_code},
        }, "s1")
        ctx.eval("window.__iv8__.page.load(window.__iv8__.data.s1)")
        ctx.eval("window.__iv8__.eventLoop.sleep(500)")

        # 修复 2: 直接读完整 jar (netLog cookieHeader 可能只含 O)
        cookies_str = ctx.eval('document.cookie')
        print(f"  [iv8] 首轮 cookie {len(cookies_str)}c: {cookies_str[:80]}...")

        # 2. 携 cookie 重载 (带 XHR hook 的真实页面 JS)
        resp2 = session.get(PAGE_HREF, headers={**headers, "Cookie": cookies_str})
        print(f"第二次请求: {resp2.status_code}")

        js_match2 = re.search(r'src="([^"]+\.js)"[^>]*r=\'m\'', resp2.text)
        js_url2 = urllib.parse.urljoin(PAGE_HREF, js_match2.group(1))
        js_code2 = session.get(js_url2, headers=headers,
                               cookies=session.cookies.get_dict()).text

        ctx.expose({
            "baseURL": PAGE_HREF, "html": resp2.text,
            "headers": strip_secure(resp2.raw.headers.items()),
            "resources": {js_url2: js_code2},
        }, "s2")
        ctx.eval("window.__iv8__.page.load(window.__iv8__.data.s2)")

        # 3. XHR 触发瑞数 hook → 捕获签名 URL
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
            print("未找到 queryList 请求"); return
        print(f"  签名 URL: {entry['url'][:80]}...")

        # 4. 重放 (当前该站 P 密码学无效, 预期 412)
        final_cookie = entry.get('cookieHeader') or cookies_str
        api_url = entry['url'] if entry['url'].startswith('http') \
            else build_environment()["location"]["origin"] + entry['url']
        resp = requests.post(api_url, data=body_str,
                             headers={**headers, "Cookie": final_cookie, **dict(entry['headers'])})
        print(f"状态码: {resp.status_code} (预期 412 — 第二层根因未修复, 见 README)")
        print(resp.text[:200])


if __name__ == "__main__":
    main()
