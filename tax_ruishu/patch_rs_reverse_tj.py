# -*- coding: utf-8 -*-
"""
rs-reverse 天津税务局适配补丁 (纯算法路线, 2026-08-16 实测 7/7 轮 200)

补丁内容:
  1. 上游 bug×2 (同 site_b): sdenv-extract paths.js Windows 反斜杠 + globalVarible 缺 get _ts()
  2. 站点适配器: 写入 src/handler/basearr/lenTj.js (173 值 basearr 完整重建)
  3. Cookie.js 修复:
     a. r2mkaTime = 当前 epoch (原 keys[21] 派生值过时, 服务端校验新鲜度)
     b. nextarr 用 spread 拼接 (numarrJoin 自动长度前缀 = 真实 8/48 标记,
        外层不能再 numarrJoin 否则多插段长前缀)
     c. hd 字节恒写 (encLen>>8|128, 非 debugger 专属)

用法: python patch_rs_reverse_tj.py   (需先 npm install rs-reverse)
"""
import io
import subprocess
from pathlib import Path

HERE = Path(__file__).parent
ADAPTER = HERE / "lenTj.js"


def resolve(request):
    r = subprocess.run(
        ["node", "-e", f"console.log(require.resolve({request!r}))"],
        capture_output=True, text=True, cwd=str(HERE),
    )
    return Path(r.stdout.strip()) if r.returncode == 0 else None


def apply(path, olds, new, desc):
    if not path or not path.exists():
        print(f"[SKIP] {desc}: 模块不存在 (先 npm install rs-reverse)")
        return False
    text = io.open(path, encoding="utf-8").read()
    hit = False
    for old in olds:
        if old in text:
            text = text.replace(old, new)
            hit = True
            break
    if hit:
        io.open(path, "w", encoding="utf-8", newline="\n").write(text)
        print(f"[OK] {desc}")
    else:
        print(f"[SKIP] {desc}: 目标代码未匹配 (版本可能已更新)")
    return hit


def main():
    # 1. 上游 bug 1: sdenv-extract paths.js Windows 反斜杠
    p = resolve("sdenv-extract")
    if p:
        p = p.parent / "utils" / "paths.js"
        apply(p, ["appDirectory.split(/[\\/]/)", "appDirectory.split('/')"],
              "appDirectory.split(/[\\\\/]/)",
              "sdenv-extract paths.js Windows 反斜杠")

    # 2. 上游 bug 2: globalVarible 缺 get _ts() getter
    p = resolve("rs-reverse")
    if p:
        gv = p.parent / "src" / "handler" / "globalVarible.js"
        text = io.open(gv, encoding="utf-8").read()
        if "get _ts()" not in text:
            anchor = "  get keys() {"
            if anchor in text:
                text = text.replace(
                    anchor,
                    "  get _ts() {\n    // makecode-high firstStep 设置的 $_ts (Cookie.js 使用)\n    return cache._ts;\n  }\n" + anchor,
                    1,
                )
                io.open(gv, "w", encoding="utf-8", newline="\n").write(text)
                print("[OK] globalVarible 补 get _ts() getter")
            else:
                print("[SKIP] globalVarible: 锚点未找到")

        # 3. 站点适配器
        dst = p.parent / "src" / "handler" / "basearr" / "lenTj.js"
        dst.write_text(ADAPTER.read_text(encoding="utf-8"), encoding="utf-8")
        print("[OK] lenTj.js 适配器已安装")

        # 4. Cookie.js: r2mkaTime epoch
        ck = p.parent / "src" / "handler" / "Cookie.js"
        apply(ck,
              ["if (!this.config.r2mkaTime) this.config.r2mkaTime = +ascii2string(gv.keys[21]);"],
              "if (!this.config.r2mkaTime) this.config.r2mkaTime = Math.floor(Date.now() / 1000);",
              "Cookie.js r2mkaTime = 当前 epoch")

        # 5. Cookie.js: nextarr spread 拼接 + hd/len 恒写 (兼容两个上游版本)
        text = io.open(ck, encoding="utf-8").read()
        old_next_variants = [
            # 变体 A: hasDebug 双条件
            """    const nextarr = numarrJoin(
      numarrJoin(
        2,
        numToNumarr4([this.config.r2mkaTime, this.config.startTime]),
        gv.keys[2]
      ),
      (gv.config.adapt?.hasDebug || (gv._getAttr('_ts') || {}).hasDebug) ? basearrEncrypt.length >> 8 & 255 | 128 : undefined,
      basearrEncrypt,
    )""",
            # 变体 B: 仅 adapt.hasDebug
            """    const nextarr = numarrJoin(
      numarrJoin(
        2,
        numToNumarr4([this.config.r2mkaTime, this.config.startTime]),
        gv.keys[2]
      ),
      gv.config.adapt?.hasDebug ? basearrEncrypt.length >> 8 & 255 | 128 : undefined,
      basearrEncrypt,
    )""",
        ]
        new_next = """    const nextarr = [
      ...numarrJoin(
        2,
        numToNumarr4([this.config.r2mkaTime, this.config.startTime]),
        gv.keys[2]
      ),
      basearrEncrypt.length >> 8 & 255 | 128,
      basearrEncrypt.length & 255,
      ...basearrEncrypt,
    ]"""
        hit = False
        for old_next in old_next_variants:
            if old_next in text:
                text = text.replace(old_next, new_next)
                io.open(ck, "w", encoding="utf-8", newline="\n").write(text)
                hit = True
                print("[OK] Cookie.js nextarr spread 拼接 + hd/len")
                break
        if not hit:
            print("[SKIP] Cookie.js nextarr: 结构未匹配 (检查版本)")

        # 6. 运行时配置: UA/platform 与请求对齐
        rc = p.parent / "src" / "config" / "makecookieRuntimeConfig.js"
        text = io.open(rc, encoding="utf-8").read()
        text = text.replace(
            "'window.navigator.userAgent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'",
            "'window.navigator.userAgent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'",
        )
        text = text.replace(
            "'window.navigator.platform': 'MacIntel'",
            "'window.navigator.platform': 'Win32'",
        )
        io.open(rc, "w", encoding="utf-8", newline="\n").write(text)
        print("[OK] makecookieRuntimeConfig UA/platform 对齐")


if __name__ == "__main__":
    main()
