# -*- coding: utf-8 -*-
"""
站点C（医院）瑞数 — 手动补环境生产爬虫 (v3 升级版, 2026-08-15)

相比 spider_manual_env.py:
  1. meta id 轮换兼容 (按 r='m' 定位, 不再硬编码 HugPYbOHyOWN)
  2. 环境模板 v3: setFuncNative 原生伪装层 (原 func_set_native 是死代码)
     + VM 执行期隐藏 process/global (node 环境检测)
  3. 412 自动恢复: 爬取中遇到 412 → 重新生成 cookie 继续
  4. 文章详情爬取 + CSV 落盘

实测: 20/20 轮列表页 200 (升级前 15/15), ~3s/次

用法: python spider_manual_prod.py
"""
import base64
import csv
import re
import subprocess
import sys
import time
from pathlib import Path

from curl_cffi import requests

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SCRIPT_DIR = Path(__file__).parent
TARGET_URL = base64.b64decode(
    "aHR0cHM6Ly9zdWdoLnN6dS5lZHUuY24vSHRtbC9OZXdzL01haW4vMTAyLmh0bWw=").decode()
BASE_URL = base64.b64decode("aHR0cHM6Ly9zdWdoLnN6dS5lZHUuY24=").decode()
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
ENV_TEMPLATE = SCRIPT_DIR / "env" / "browser_envs.js"
WAIT_MS = 1500
MAX_REGENS = 5


def generate_cookies(session):
    """412 → O-cookie; Node v3 补环境执行 VM → P-cookie"""
    resp = session.get(TARGET_URL, headers={"User-Agent": UA},
                       impersonate="chrome110", timeout=15)
    if resp.status_code != 412:
        raise RuntimeError(f"Expected 412, got {resp.status_code}")
    html = resp.text
    meta = re.search(r'<meta[^>]*r=[\'"]m[\'"][^>]*>', html)
    script = re.search(r"<script[^>]*r='m'[^>]*>\s*(\$_ts=.*?)</script>", html, re.DOTALL)
    vm = re.search(r'<script[^>]*src="(/[^"]+\.js)"', html)
    if not (meta and script and vm):
        raise RuntimeError("412 页结构变化: meta/script/vm 提取失败")
    arg1 = re.search(r'content="([^"]*)"', meta.group(0)).group(1)
    arg2 = script.group(1).strip()
    ts_code = session.get(BASE_URL + vm.group(1),
                          headers={"User-Agent": UA, "Referer": TARGET_URL},
                          impersonate="chrome110", timeout=15).text

    env_js = ENV_TEMPLATE.read_text(encoding="utf-8")
    env_js = env_js.replace("arg1_content", arg1)
    env_js = env_js.replace('"arg2_js"', arg2)
    env_js = env_js.replace('"ts_code"', ts_code)
    env_js += (
        f'\n;setTimeout(function(){{ console.log("COOKIE_START:" + get_cookie() + ":COOKIE_END"); process.exit(0); }}, {WAIT_MS});'
    )
    tmp = SCRIPT_DIR / "_run_tmp.js"
    tmp.write_text(env_js, encoding="utf-8")
    try:
        r = subprocess.run(["node", str(tmp)], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=60,
                           cwd=str(SCRIPT_DIR))
    finally:
        tmp.unlink()
    m = re.search(r"COOKIE_START:(.*?):COOKIE_END", r.stdout + r.stderr, re.S)
    if not m:
        raise RuntimeError(f"P-cookie 生成失败: {(r.stdout + r.stderr)[-300:]}")
    for part in m.group(1).strip().split(";"):
        part = part.strip()
        if "=" in part and not part.startswith(("path=", "expires=", "Secure", "domain=")):
            k, _, v = part.partition("=")
            session.cookies.set(k.strip(), v.strip())
    return session


def fetch(session, url, referer=TARGET_URL):
    """带 412 自动恢复的请求"""
    resp = session.get(url, headers={"User-Agent": UA, "Referer": referer},
                       impersonate="chrome110", timeout=15)
    if resp.status_code == 412:
        for i in range(MAX_REGENS):
            print(f"  [412] 重新生成 cookie ({i + 1}/{MAX_REGENS})...")
            generate_cookies(session)
            resp = session.get(url, headers={"User-Agent": UA, "Referer": referer},
                               impersonate="chrome110", timeout=15)
            if resp.status_code != 412:
                break
    return resp


def extract_articles(html):
    articles = []
    seen = set()
    for href, title_html in re.findall(
            r'<a[^>]*href="(/Html/News/Articles/\d+\.html)"[^>]*>(.*?)</a>', html, re.DOTALL):
        if href in seen:
            continue
        title = re.sub(r'<[^>]+>', '', title_html).strip()
        if not title or title in ('[详细]', '[详情]', '详细', '详情'):
            continue
        seen.add(href)
        articles.append({'url': BASE_URL + href, 'title': title})
    return articles


def extract_detail(html):
    date = content = ''
    for pat in [r'(\d{4}[-/]\d{2}[-/]\d{2})', r'发布时间[：:]\s*(\d{4}[-/]\d{2}[-/]\d{2})']:
        m = re.search(pat, html)
        if m:
            date = m.group(1)
            break
    for pat in [r'<div[^>]*class="[^"]*content[^"]*"[^>]*>(.*?)</div>',
                r'<div[^>]*id="[^"]*content[^"]*"[^>]*>(.*?)</div>']:
        m = re.search(pat, html, re.DOTALL)
        if m:
            content = re.sub(r'<[^>]+>', '', m.group(1)).strip()
            break
    if not content:
        text = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL)
        text = re.sub(r'<[^>]+>', '\n', text)
        text = re.sub(r'\n\s*\n+', '\n', text).strip()
        content = text[:2000]
    return date, content


def main():
    t0 = time.time()
    session = requests.Session()
    print("[1] 生成 cookie ...")
    generate_cookies(session)

    print("[2] 抓列表页 ...")
    resp = fetch(session, TARGET_URL)
    print(f"  列表: {resp.status_code} {len(resp.text)}b")
    articles = extract_articles(resp.text)
    print(f"  提取 {len(articles)} 篇文章")

    print("[3] 抓文章详情 ...")
    rows = []
    for i, art in enumerate(articles):
        r = fetch(session, art['url'])
        if r.status_code != 200:
            print(f"  [{i + 1}/{len(articles)}] {r.status_code} 跳过: {art['title'][:30]}")
            continue
        date, content = extract_detail(r.text)
        rows.append({'title': art['title'], 'url': art['url'], 'date': date, 'content': content})
        if (i + 1) % 10 == 0:
            print(f"  [{i + 1}/{len(articles)}] 已抓 {len(rows)} 篇")
        time.sleep(0.3)

    out = SCRIPT_DIR / "articles_manual.csv"
    with open(out, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=['title', 'url', 'date', 'content'])
        w.writeheader()
        w.writerows(rows)
    print(f"\n完成: {len(rows)}/{len(articles)} 篇, 总耗时 {time.time() - t0:.1f}s → {out}")


if __name__ == "__main__":
    main()
