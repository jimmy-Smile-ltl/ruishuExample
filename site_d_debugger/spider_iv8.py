"""
spider_iv8.py — 站点D（药监局）iv8 运行时路线（方案 7）

iv8 = Python 原生 V8 + C++ 层浏览器环境（pip install iv8, 社区版）。
瑞数 VM 直接在 iv8 里执行出 P-cookie, 无需手写补环境 / 无需浏览器。

★ 实测 (2026-09-05): 阿莫西林 575 条, 接口 {"code":200}, iv8 出 cookie 0.65s

链路:
  requests 请求 (MD5 sign 旧版接口签名)
    → 首次 412 → 预取 VM js → iv8 JSContext + page.load 执行 VM → document.cookie 出 P
    → 携 cookie 重放 → 200 JSON 数据

依赖: pip install iv8 requests
用法: python spider_iv8.py [--kw 阿莫西林] [--page 1]

改编自 iv8 上游仓库 examples（github.com/HanZzzzz000/iv8, 社区版非商用许可）。
本脚本仅收录用法示例; iv8 本体请自行 pip 安装。
"""
import re
import time
import base64
import hashlib
import argparse
import urllib.parse

import iv8
import requests

# 目标 URL (base64, 运行时解码)
_B = lambda s: base64.b64decode(s).decode()
PAGE_HREF = _B("aHR0cHM6Ly93d3cubm1wYS5nb3YuY24vZGF0YXNlYXJjaC9zZWFyY2gtcmVzdWx0Lmh0bWw=")
_ORIGIN = _B("aHR0cHM6Ly93d3cubm1wYS5nb3YuY24=")
API_URL = _B("aHR0cHM6Ly93d3cubm1wYS5nb3YuY24vZGF0YXNlYXJjaC9kYXRhL25tcGFkYXRhL3NlYXJjaA==")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

DEFAULT_ITEM_ID = "ff80808183cad75001840881f848179f"  # 境内生产药品


def json_md5_to_str(input_str, app_secret="nmpasecret2020"):
    """旧版搜索接口 MD5 sign: 严格 URL 编码 (含 ~) + 盐"""
    input_str += "&" + app_secret
    encoded = urllib.parse.quote(input_str, safe='').replace('~', '%7E')
    return hashlib.md5(encoded.encode('utf-8')).hexdigest()


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


def gen_cookies(session, headers, params):
    """412 → iv8 执行 VM → 返回 cookie dict (含 P-cookie)"""
    cookies = {}
    resp = session.get(API_URL, params=params, headers=headers)
    if resp.status_code == 200:
        return cookies, resp  # 直接 200: 会话内 cookie 已有效
    cookies.update(resp.cookies.get_dict())

    js_match = re.search(r'src="([^"]+\.js)"[^>]*r=\'m\'', resp.text)
    js_url = _ORIGIN + js_match.group(1)
    js_code = session.get(js_url, headers=headers, cookies=cookies).text

    t0 = time.time()
    with iv8.JSContext(environment=build_environment(),
                       config={"timezone": "Asia/Shanghai"}) as ctx:
        ctx.expose({
            "baseURL": PAGE_HREF,
            "html": resp.text,
            "headers": [[k, v] for k, v in resp.headers.items()],
            "resources": {js_url: js_code},
        }, "snapshot")
        ctx.eval("__iv8__.page.load(__iv8__.data.snapshot);")
        dc = ctx.eval('document.cookie')
        for item in dc.split(';'):
            if '=' in item:
                k, v = item.strip().split('=', 1)
                cookies[k] = v
        print(f"  [iv8] cookie 生成 {time.time() - t0:.2f}s, jar {len(cookies)} 项")
    return cookies, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kw", default="阿莫西林")
    ap.add_argument("--page", type=int, default=1)
    args = ap.parse_args()

    params = {
        "itemId": DEFAULT_ITEM_ID,
        "isSenior": "N",
        "searchValue": args.kw,
        "pageNum": args.page,
        "pageSize": 10,
        "timestamp": int(time.time()) * 1000,
    }
    headers = {
        "Accept": "application/json, text/plain, */*",
        "User-Agent": UA,
        "sign": json_md5_to_str("&".join([f"{k}={v}" for k, v in sorted(params.items())])),
        "timestamp": str(params["timestamp"]),
    }

    session = requests.Session()
    cookies, direct = gen_cookies(session, headers, params)
    if direct is not None:
        resp = direct
    else:
        resp = session.get(API_URL, params=params, headers=headers, cookies=cookies)
    print(f"状态码: {resp.status_code}")
    body = resp.content.decode('utf-8', errors='replace')
    m = re.search(r'"total":(\d+)', body)
    if m:
        print(f"✅ 数据接口通过: total={m.group(1)}")
    print(body[:300])


if __name__ == "__main__":
    main()
