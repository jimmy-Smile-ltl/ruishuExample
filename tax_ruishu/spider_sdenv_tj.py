"""
spider_sdenv_tj.py — 天津税务局 瑞数6 sdenv 补环境方案

链路: curl_cffi(chrome110, verify=False 国密证书) 抓 412 挑战页
  → 下载 VM js → node generate_cookie_tj.js (jsdomFromText + meta + O cookie)
  → 异步 timer 生成 P cookie → 携 cookie 重放 200

用法: python spider_sdenv_tj.py [--url=...] [--rounds=3]
"""
import base64
import sys, re, os, time, argparse, subprocess
from pathlib import Path
import curl_cffi.requests as req

if sys.platform == 'win32': sys.stdout.reconfigure(encoding='utf-8', errors='replace')

PROJ = Path(__file__).parent
OUT = PROJ / 'output'
OUT.mkdir(exist_ok=True)

# === sdenv node_modules 自动探测 ===
# 不硬编码个人路径: 优先环境变量 SDENV_DIR, 其次本目录 node_modules,
# 再扫描 ../spider research/其他/ 下已装过 sdenv 的项目 (pro11/pro36 等) 复用。
def _find_sdenv_dir():
    env_dir = os.environ.get('SDENV_DIR', '')
    for cand in ([Path(env_dir)] if env_dir else []) + [PROJ / 'node_modules']:
        if cand and (cand / 'sdenv').exists():
            return str(cand)
    other = PROJ.parent.parent.parent / 'spider research' / '其他'
    if other.exists():
        for proj in sorted(other.iterdir()):
            for sub in ('sdenv', 'sdenv_template'):
                nm = proj / sub / 'node_modules'
                if nm.exists() and (nm / 'sdenv').exists():
                    return str(nm)
    return ''

SDENV_DIR = _find_sdenv_dir()
if not SDENV_DIR:
    raise SystemExit('[FATAL] 找不到 sdenv node_modules — 请设置 SDENV_DIR 或 npm install sdenv')
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
NODE_ENV = {**os.environ, 'SDENV_DIR': SDENV_DIR}

# 目标 URL (base64, 运行时解码)
TARGET = base64.b64decode(
    "aHR0cHM6Ly9ldGF4LnRpYW5qaW4uY2hpbmF0YXguZ292LmNuOjg0NDMv").decode()


def extract_vm_src(html):
    """412 挑战页 script2 的外链 VM 路径"""
    m = re.search(r'<script[^>]*src="([^"]+)"', html)
    return m.group(1) if m else None


def get_ocookie(session):
    """取 412 轮 O cookie（名称以 S 结尾，与 P 成对）"""
    o = []
    try:
        for k, v in session.cookies.items():
            if not k.endswith('T'): o.append(f'{k}={v}')
    except Exception:
        for c in session.cookies:
            k, _, v = str(c).partition('=')
            if k and not k.endswith('T'): o.append(f'{k}={v}')
    return '; '.join(o) if o else ''


class SdenvTjSpider:
    def __init__(self, url=TARGET):
        self.url = url
        self.session = req.Session()
        self.cookie_ok = False

    def gen_cookies(self):
        """一轮: 抓 412 → 下载 VM → node sdenv → 返回 P cookie 串"""
        r = self.session.get(self.url, headers={'User-Agent': UA}, impersonate='chrome110',
                             verify=False, timeout=30)
        html = r.text
        print(f"  [412] status={r.status_code} len={len(html)}")

        # VM 外链下载
        vm_src = extract_vm_src(html)
        if vm_src:
            vm_url = vm_src if vm_src.startswith('http') else self.url.rstrip('/') + '/' + vm_src.lstrip('/')
            vr = self.session.get(vm_url, headers={'User-Agent': UA}, impersonate='chrome110',
                                  verify=False, timeout=30)
            vm_file = OUT / 'vm.js'
            vm_file.write_bytes(vr.content)
            print(f"  [VM] {vm_url.split('/')[-1]} {len(vr.content)}B")
        else:
            # 内联 VM 情形
            m = re.search(r'<script[^>]*>([\s\S]*?)(?:</script>)', html)
            vm_file = OUT / 'vm.js'
            vm_file.write_text(m.group(1), encoding='utf-8') if m else None
            if not (vm_file.exists() and vm_file.stat().st_size):
                print("  [VM] 未找到，放弃本轮"); return ''

        html_file = OUT / 'challenge.html'
        html_file.write_text(html, encoding='utf-8')
        ocookie = get_ocookie(self.session)

        # node sdenv 生成
        subprocess.run(
            ['node', str(PROJ / 'generate_cookie_tj.js'),
             '--html=' + str(html_file), '--vm=' + str(vm_file),
             '--url=' + self.url, '--ocookie=' + ocookie,
             '--wait=12', '--output=' + str(OUT / 'ck_sdenv.txt')],
            capture_output=True, text=True, timeout=30, cwd=str(PROJ), env=NODE_ENV)

        ckf = OUT / 'ck_sdenv.txt'
        ck = ckf.read_text(encoding='utf-8').strip() if ckf.exists() else ''
        if len(ck) > 200:
            self.cookie_ok = True
            return ck
        print(f"  [FAIL] cookie 仅 {len(ck)} chars")
        return ''

    def verify(self, ck):
        """用生成 cookie 重放，验证 200"""
        s = req.Session()
        for part in ck.split(';'):
            part = part.strip()
            if '=' not in part: continue
            k, v = part.split('=', 1)
            s.cookies.set(k.strip(), v.split(';')[0].strip())
        r = s.get(self.url, headers={'User-Agent': UA, 'Referer': self.url},
                  impersonate='chrome110', verify=False, timeout=30)
        title = re.search(r'<title>([^<]*)</title>', r.text)
        ok = r.status_code == 200 and len(r.text) > 5000
        print(f"  [verify] {r.status_code} {len(r.text)}B - {title.group(1).strip() if title else 'unk'} "
              f"{'✅ OK' if ok else '❌ FAIL'}")
        if ok:
            (OUT / 'tj_200_sdenv.html').write_text(r.text, encoding='utf-8')
        return ok

    def run(self, rounds=3):
        for i in range(rounds):
            t0 = time.time()
            print(f"轮次 {i+1}/{rounds}:")
            ck = self.gen_cookies()
            if ck and self.verify(ck):
                print(f"  ✅ 成功 {time.time()-t0:.1f}s")
                return True
            time.sleep(2)
        print("❌ 全部失败")
        return False


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--url', default=TARGET)
    p.add_argument('--rounds', type=int, default=3)
    args = p.parse_args()
    print(f'sdenv 补环境: {args.url}')
    SdenvTjSpider(args.url).run(args.rounds)


if __name__ == '__main__':
    main()
