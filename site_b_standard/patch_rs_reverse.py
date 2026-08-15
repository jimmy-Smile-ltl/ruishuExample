"""
rs-reverse v1.16.3 的两个上游 bug 补丁（Windows 必需）

1. sdenv-extract@0.1.8 utils/paths.js:
   split('/') 或 split(/[\\/]/) 都不匹配 Windows 反斜杠路径
   -> appDirectory=false -> path.resolve 崩
   (任何依赖 sdenv-extract 的工具在 Windows 都会踩)

2. rs-reverse src/handler/globalVarible.js:
   缺 get _ts() getter -> makecode-high 路径 (额外 debugger 版本站点) 必崩

补丁位置: 通过 node require.resolve 动态定位
(本目录或向上任意一级 node_modules, 如用户根目录的全局安装)

用法: python patch_rs_reverse.py
"""
import io
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent


def resolve(request):
    """node require.resolve 定位模块实际路径"""
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
    if hit:
        io.open(path, "w", encoding="utf-8").write(text)
        print(f"[PATCHED] {desc}: {path}")
    else:
        print(f"[OK] {desc}: 已打过补丁或版本不同 ({path.name})")
    return True


def main():
    ok = True
    # 1. sdenv-extract Windows 路径补丁
    paths_js = resolve("sdenv-extract/utils/paths.js")
    ok &= apply(
        paths_js,
        [
            ".split('/')",
            ".split(/[\\/]/)",
        ],
        ".split(/[\\\\/]/)",
        "sdenv-extract Windows 路径补丁",
    )

    # 2. rs-reverse _ts getter 补丁
    gv_js = resolve("rs-reverse/src/handler/globalVarible.js")
    ok &= apply(
        gv_js,
        [
            "  get ts() {\n    // 返回$_ts\n    return cache.ts;\n  }",
        ],
        "  get ts() {\n    // 返回$_ts\n    return cache.ts;\n  }\n"
        "  get _ts() {\n    // makecode-high firstStep 设置的 $_ts (Cookie.js 使用)\n"
        "    return cache._ts;\n  }",
        "rs-reverse _ts getter 补丁",
    )
    if not ok:
        sys.exit(1)
    print("补丁完成")


if __name__ == "__main__":
    main()
