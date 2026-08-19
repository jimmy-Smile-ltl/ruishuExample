"""
瑞数 sdenv 补环境爬虫 — 大学高校通用模板

方案: sdenv (redirect-blocked) + curl_cffi

用法:
    python spider_sdenv.py --url <目标URL> [--dept-url <URL>]

依赖安装:
    sdenv 含 native canvas, Windows 上 npm install 需 VS Build Tools (gyp 编译)。
    已装过 sdenv 的环境 (如 pro36 sdenv_template / pro11 sdenv) 可直接复用其
    node_modules —— 本脚本自动探测, 无需重复编译。
"""
import re
import json
import time
import sys
import argparse
import subprocess
import os
from pathlib import Path
import curl_cffi.requests as requests

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

SCRIPT_DIR = Path(__file__).parent
PROJ_DIR = SCRIPT_DIR
SHARED_DIR = PROJ_DIR / "shared"
OUTPUT_DIR = PROJ_DIR / "output"
SHARED_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"

# === sdenv node_modules 自动探测 ===
# sdenv 的 native canvas 在无 VS Build Tools 的 Windows 上编译不过,
# 若本目录 node_modules 不存在, 自动扫描 ../spider research/其他/ 下
# 已装过 sdenv 的项目直接复用 (pro11/pro36 等)。
_NODE_MODULES_CANDIDATES = [SCRIPT_DIR / "node_modules"]
_OTHER_DIR = SCRIPT_DIR.parent.parent.parent / "spider research" / "其他"
if _OTHER_DIR.exists():
    for _proj in sorted(_OTHER_DIR.iterdir()):
        for _sub in ("sdenv", "sdenv_template"):
            _nm = _proj / _sub / "node_modules"
            if _nm.exists() and (_nm / "sdenv").exists():
                _NODE_MODULES_CANDIDATES.append(_nm)
NODE_PATH = os.environ.get('NODE_PATH', '')
for _cand in _NODE_MODULES_CANDIDATES:
    if _cand.exists() and (_cand / 'sdenv').exists():
        NODE_PATH = str(_cand)
        break
_NODE_ENV = {**os.environ, 'NODE_PATH': NODE_PATH}


def generate_cookies(url: str, wait_sec: int = 8) -> requests.Session:
    """
    通过 sdenv (redirect-blocked 模式) 生成完整 Cookie，
    返回带 Cookie 的 curl_cffi Session。
    """
    t0 = time.time()
    print(f"\n[生成 Cookie] {url}")

    result = subprocess.run(
        ["node", str(SCRIPT_DIR / "generate_cookie.js"),
         "--url", url,
         "--wait", str(wait_sec)],
        capture_output=True, text=True, timeout=wait_sec + 30,
        cwd=str(SCRIPT_DIR), env=_NODE_ENV,
    )

    for line in result.stderr.strip().split("\n"):
        line = line.strip()
        if line and any(kw in line for kw in
                        ("完成", "chars", "BLOCKED", "写入", "失败", "FATAL")):
            print(f"  [sdenv] {line.split('] ', 1)[-1] if '] ' in line else line}")

    stdout = result.stdout.strip()
    if not stdout:
        print(f"  [FAIL] sdenv 未生成 Cookie (exit={result.returncode})")
        return None

    # 读取 cookie 文件（更可靠）
    cookie_file = OUTPUT_DIR / "_cookie.txt"
    if cookie_file.exists():
        all_cookies = cookie_file.read_text(encoding="utf-8").strip()
    else:
        all_cookies = stdout

    # 注入到 curl_cffi session
    session = requests.Session()
    for part in all_cookies.split(";"):
        part = part.strip()
        if "=" not in part:
            continue
        if part.lower().startswith(
                ("path=", "expires=", "secure", "domain=", "max-age=", "httponly")):
            continue
        k, v = part.split("=", 1)
        session.cookies.set(k.strip(), v.split(";")[0].strip())

    elapsed = time.time() - t0
    cookies_count = len(dict(session.cookies))
    print(f"  [OK] {cookies_count} cookies, {elapsed:.1f}s")
    for k, v in dict(session.cookies).items():
        print(f"       {k}={v[:50]}{'...' if len(v) > 50 else ''}")

    return session


def fetch_page(session: requests.Session, url: str, retry: bool = True) -> str:
    """curl_cffi 请求页面，自动处理 412"""
    resp = session.get(
        url,
        headers={"User-Agent": UA, "Referer": url},
        impersonate="chrome110",
        timeout=15,
    )

    if resp.status_code == 200:
        return resp.text

    if resp.status_code in (412, 403) and retry:
        print(f"  Cookie 过期/无效，重新生成...")
        new_session = generate_cookies(url)
        if new_session:
            session.cookies.clear()
            for k, v in dict(new_session.cookies).items():
                session.cookies.set(k, v)
            return fetch_page(session, url, retry=False)

    print(f"  [{resp.status_code}] {url}")
    return None


def extract_links(html: str, base_url: str, pattern: str = None) -> list:
    """从 HTML 中提取链接"""
    links = set()
    # 默认匹配院系链接: href="...xxx/yyy.htm..."
    if pattern:
        for m in re.finditer(pattern, html):
            link = m.group(1) if m.lastindex else m.group(0)
            links.add(link)
    else:
        # 通用: 提取所有 a href
        for m in re.finditer(r'href="([^"]+)"', html):
            href = m.group(1)
            if href.startswith("/") or base_url in href:
                links.add(href)

    from urllib.parse import urljoin
    return [urljoin(base_url, l) for l in links]


def main():
    parser = argparse.ArgumentParser(description="瑞数 sdenv 补环境爬虫")
    parser.add_argument("--url", required=True, help="目标网站首页 URL")
    parser.add_argument("--dept-url", help="院系页面 URL (可选)")
    parser.add_argument("--wait", type=int, default=8, help="等待 cookie 生成时间 (秒)")
    args = parser.parse_args()

    base_url = args.url

    print("=" * 60)
    print("瑞数 sdenv 补环境 — 大学高校通用方案")
    print("=" * 60)

    # Step 1: 生成 Cookie
    session = generate_cookies(base_url, wait_sec=args.wait)
    if session is None:
        print("\n[FATAL] Cookie 生成失败")
        sys.exit(1)

    # Step 2: 测试首页
    print(f"\n{'─' * 60}")
    print("测试: 首页")
    print(f"{'─' * 60}")

    html = fetch_page(session, base_url)
    if html:
        title = re.search(r'<title>([^<]+)</title>', html)
        print(f"  ✅ 首页访问成功!")
        print(f"  标题: {title.group(1).strip() if title else '(未找到)'}")
        print(f"  大小: {len(html)} bytes")

        # 保存首页
        out_path = OUTPUT_DIR / "homepage.html"
        out_path.write_text(html, encoding="utf-8")
        print(f"  已保存: {out_path}")
    else:
        print(f"  ❌ 首页访问失败")
        sys.exit(1)

    # Step 3: 爬取院系页面 (如果指定)
    if args.dept_url:
        print(f"\n{'─' * 60}")
        print(f"目标: 院系页面")
        print(f"{'─' * 60}")

        dept_html = fetch_page(session, args.dept_url)
        if dept_html:
            print(f"  ✅ 院系页面访问成功! ({len(dept_html)} bytes)")

            # 提取院系链接
            links = extract_links(dept_html, base_url)
            print(f"  发现 {len(links)} 个链接")

            out_path = OUTPUT_DIR / "dept_page.html"
            out_path.write_text(dept_html, encoding="utf-8")
            print(f"  已保存: {out_path}")

            # 保存链接
            (OUTPUT_DIR / "dept_links.json").write_text(
                json.dumps(links, indent=2, ensure_ascii=False), encoding="utf-8")
            print(f"  链接已保存: output/dept_links.json")

            # 尝试爬取前几个院系页面
            print(f"\n  尝试爬取前 3 个院系详情页...")
            for i, link in enumerate(links[:3], 1):
                detail_html = fetch_page(session, link)
                if detail_html:
                    title = re.search(r'<title>([^<]+)</title>', detail_html)
                    print(f"    [{i}] ✅ {link} — {title.group(1).strip() if title else 'N/A'}")
                else:
                    print(f"    [{i}] ❌ {link}")
        else:
            print(f"  ❌ 院系页面访问失败")

    print(f"\n{'=' * 60}")
    print("完成")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
