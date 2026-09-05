# ============================================================
# iv8_ruishu_util.py — 用 iv8 破解瑞数 WAF 的共享工具（全库通用）
#
# iv8 = Python 原生 V8 扩展 + C++ 层浏览器环境（pip install iv8，社区版非商用许可，
#      项目地址 github.com/HanZzzzz000/iv8 —— 本项目所有 iv8 路线代码均改编自其 examples）
#
# 核心链路（2026-09-05 全库 13 站实测通过）：
#   1. Python(requests/curl_cffi) 抓 412/202 挑战页 + 下发 cookie
#   2. iv8 page.load 离线执行挑战 JS（VM）→ document.cookie 生成 P/T
#   3. cookie 回放 → 200
#
# 三大坑（血泪经验）：
#   - http:// 站点 + Secure cookie 会被 iv8 0.1.4 整体丢弃（Chrome 语义是忽略属性照存）
#     → http 站点自动安装 hook_strip_secure.js
#   - 多轮挑战必须每轮【全新 JSContext】——复用 context 时 window.$_ts 残留污染，
#     第 2 轮起 VM 不写 P（nodenv 每轮全新 node 进程也是同一个道理）
#   - cookie 读完整 jar（document.cookie），netLog cookieHeader 可能缺 P
# ============================================================

import re
import urllib.parse
from pathlib import Path

import iv8

_HERE = Path(__file__).parent
_HOOK_JS = (_HERE / "hook_strip_secure.js").read_text(encoding="utf-8")

# 常见浏览器头
UA_CHROME114 = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36")
UA_CHROME124 = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def make_environment(page_url: str, ua: str = UA_CHROME114) -> dict:
    """由页面 URL 构造 iv8 的 environment（location + navigator）"""
    p = urllib.parse.urlsplit(page_url)
    return {
        "location": {
            "ancestorOrigins": {},
            "href": page_url,
            "origin": f"{p.scheme}://{p.netloc}",
            "protocol": f"{p.scheme}:",
            "host": p.netloc,
            "hostname": p.hostname,
            "port": str(p.port or ""),
            "pathname": p.path or "/",
            "search": f"?{p.query}" if p.query else "",
            "hash": "",
        },
        "navigator": {"userAgent": ua},
    }


def strip_secure_from_headers(resp) -> list:
    """构造 page.load 用的响应头列表：
    - 用 getlist() 保留重复 Set-Cookie 头（resp.raw.headers.items() 会丢）
    - http 站点剥离 Set-Cookie 里的 Secure（对齐 Chrome 在非 https 页忽略 Secure）"""
    raw = getattr(resp, "raw", None)
    hdrs = raw.headers if raw is not None else resp.headers
    out = []
    seen = set()
    for k in list(hdrs.keys()):
        kk = k.lower()
        if kk in seen:
            continue
        seen.add(kk)
        try:
            vals = hdrs.getlist(k)
        except AttributeError:
            vals = [hdrs.get(k)] if hdrs.get(k) else []
        for v in vals:
            if kk == "set-cookie":
                v = re.sub(r";\s*secure\b", "", v, flags=re.I)
            out.append([k, v])
    return out


def extract_js_url(resp, page_url: str):
    """从挑战页提取外部 JS 路径（src="...js" 且 r='m'）"""
    m = re.search(r'src="([^"]+\.js)"[^>]*r=\'m\'', resp.text)
    if not m:
        m = re.search(r"src=\"([^\"]+\.js)\"[^>]*r='m'", resp.text)
    return urllib.parse.urljoin(page_url, m.group(1)) if m else None


def solve_challenge(page_url: str, resp, js_code: str = None,
                    js_url: str = None, ua: str = UA_CHROME114,
                    wait_ms: int = 1500, timezone: str = "Asia/Shanghai",
                    auto_fetch_js: bool = True, fetch_headers: dict = None,
                    fetch_cookies: dict = None, js_fetcher=None) -> str:
    """在全新 iv8 JSContext 中执行挑战页，返回 document.cookie 完整 jar。

    参数:
      resp          : 412/202 挑战页响应（html + Set-Cookie 头一并喂给 iv8）
      js_code/js_url: 外部 JS 内容/URL；不传且 auto_fetch_js=True 时自动从 resp 提取并下载
      js_fetcher    : 自定义 JS 下载函数(url) -> str（如用 curl_cffi session 保 TLS 指纹）
      返回          : document.cookie 字符串（可能为空 = 挑战未产出）
    """
    import requests as _requests

    if js_url is None and auto_fetch_js:
        js_url = extract_js_url(resp, page_url)
    if js_code is None and js_url:
        if js_fetcher is not None:
            js_code = js_fetcher(js_url)
        else:
            r = _requests.get(js_url,
                              headers={"User-Agent": ua, **(fetch_headers or {})},
                              cookies=fetch_cookies, timeout=20, verify=False)
            js_code = r.text

    env = make_environment(page_url, ua)
    is_http = urllib.parse.urlsplit(page_url).scheme == "http"

    with iv8.JSContext(environment=env, config={"timezone": timezone}) as ctx:
        if is_http:
            ctx.eval(_HOOK_JS)  # 剥离 Secure，防止 http 站点 cookie 被 iv8 丢弃
        snapshot = {
            "baseURL": page_url,
            "html": resp.text,
            "headers": strip_secure_from_headers(resp),
            "resources": ({js_url: js_code} if js_url and js_code else {}),
        }
        ctx.expose(snapshot, "s")
        ctx.eval("window.__iv8__.page.load(window.__iv8__.data.s)")
        ctx.eval(f"window.__iv8__.eventLoop.sleep({wait_ms})")
        return ctx.eval("document.cookie")


def apply_cookies(session, cookie_str: str):
    """把 iv8 产出的 cookie 串合入 Python session"""
    for part in cookie_str.split(";"):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            session.cookies.set(k.strip(), v.strip())


def chain_get(session, page_url: str, headers: dict, max_rounds: int = 3,
              wait_ms: int = 1500, verbose: bool = True, js_fetcher=None):
    """412/202 → iv8 挑战 → 回放 的完整链式循环（对齐 nodenv 每轮全新 VM 的做法）

    返回: 最终响应（200 = 破解成功）；每轮挑战用全新 JSContext。
    """
    for rnd in range(1, max_rounds + 1):
        resp = session.get(page_url, headers=headers, timeout=25, verify=False)
        if verbose:
            print(f"  round {rnd}: {resp.status_code} len={len(resp.text)}")
        if resp.status_code != 412 and resp.status_code != 202:
            return resp
        dc = solve_challenge(page_url, resp, wait_ms=wait_ms,
                             fetch_headers=headers, js_fetcher=js_fetcher)
        if not dc:
            if verbose:
                print("  [FAIL] iv8 未产出 cookie")
            continue
        if verbose:
            print(f"  iv8 cookie: {dc[:90]}...")
        apply_cookies(session, dc)
    resp = session.get(page_url, headers=headers, timeout=25, verify=False)
    if verbose:
        print(f"  final: {resp.status_code} len={len(resp.text)}")
    return resp


def report(name: str, page_url: str, resp, elapsed: float):
    """统一的成败输出"""
    print("=" * 70)
    print(f"iv8 瑞数破解验证 — {name} {page_url}")
    print("=" * 70)
    if resp is not None and resp.status_code == 200:
        m = re.search(r"<title>([^<]*)</title>", resp.text)
        print(f"\n  ✅ 200  {len(resp.text)}b  "
              f"{m.group(1).strip() if m else ''}  ({elapsed:.1f}s)")
    else:
        print(f"\n  ❌ {resp.status_code if resp is not None else 'None'}  ({elapsed:.1f}s)")
    print("=" * 70)
