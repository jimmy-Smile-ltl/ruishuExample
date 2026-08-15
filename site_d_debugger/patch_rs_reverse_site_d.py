"""
rs-reverse v1.16.3 站点D 补丁（Windows 必需）

1. sdenv-extract@0.1.8 utils/paths.js Windows 路径补丁
2. rs-reverse globalVarible.js 缺 _ts getter 补丁（makecode-high 路径必崩）
3. ★ 站点D len160 适配器注入: src/handler/basearr/len160.js
   （2026-08-15 实测: 站点D 真实 basearrEncrypt=160, 随机字节段 155;
   无此适配器 cookie 必被 412 拒）

补丁位置: 通过 node require.resolve 动态定位
（本目录或向上任意一级 node_modules）

用法: python patch_rs_reverse_site_d.py
"""
import io
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent

LEN160_JS = """// 站点D 新 VM 适配器 (2026-08-15 实测: 真实 basearrEncrypt=160)
// 基于 len103 结构, 随机字节段 98→155 (+57)
const parser = require('../parser/');
const gv = require('../globalVarible');

const {
  fixedValue20,
  numToNumarr2,
  numToNumarr4,
  numToNumarr8,
  uuid,
  string2ascii,
  execRandomByNumber,
  execNumberByTime,
  hexnum,
  ascii2string,
  numarrAddTime,
  decode,
  decrypt,
  encryptMode2,
  numarrJoin,
} = parser;

function getBasearr(hostname, config) {
  if (!gv.config.adapt?.flag) throw new Error('适配器配置项flag值未定义');
  return numarrJoin(
    3,
    numarrJoin(
      1,
      config['window.navigator.maxTouchPoints'],
      config['window.eval.toString().length'],
      128,
      ...numToNumarr4(uuid(config['window.navigator.userAgent'])),
      string2ascii(config['window.navigator.platform']),
      ...numToNumarr4(config.execNumberByTime),
      ...execRandomByNumber(155, config.random),
      0,
      0,
      ...numToNumarr4(Number(hexnum('3136373737323136'))),
    ),
    10,
    (() => {
      const flag = +ascii2string(gv.keys[24]);
      return [
        flag > 0 && flag < 8 ? 1 : 0,
        13,
        ...numToNumarr4(config.r2mkaTime + config.runTime - config.startTime),
        ...numToNumarr4(+ascii2string(gv.keys[19])),
        ...numToNumarr8(Math.floor((config.random || Math.random()) * 1048575) * 4294967296 + (((config.currentTime + 0) & 4294967295) >>> 0)),
        flag,
      ];
    })(),
    7,
    [
      ...numToNumarr4(16777216),
      ...numToNumarr4(0),
      ...numToNumarr2(gv.config.adapt.flag),
      ...numToNumarr2(config.codeUid),
    ],
    0,
    [0],
    6,
    [
      1,
      ...numToNumarr2(0),
      ...numToNumarr2(0),
      config['window.document.hidden'] ? 0 : 1,
      ...encryptMode2(decrypt(ascii2string(gv.keys[22])), numarrAddTime(gv.keys[16])[0]),
      ...numToNumarr2(+decode(decrypt(ascii2string(gv.keys[22])))),
    ],
    2,
    fixedValue20(),
    9,
    (() => {
      const { connType } = config['window.navigator.connection'];
      const { charging, chargingTime, level } = config['window.navigator.battery']
      const connTypeIdx = ['bluetooth', 'cellular', 'ethernet', 'wifi', 'wimax'].indexOf(connType) + 1;
      let oper = 0;
      if (level) oper |= 2;
      if (charging) oper |= 1;
      if (connTypeIdx !== undefined) oper |= 8
      return [
        oper,
        level * 100,
        ...numToNumarr2(chargingTime),
        connTypeIdx,
      ]
    })(),
    13,
    [0],
  )
}

Object.assign(getBasearr, {
  adapt: ["V1RJWBdeVk8XWlc="],
  "V1RJWBdeVk8XWlc=": {
    lastWord: 'T',
    flag: 3344,
    devUrl: 'UU1NSUoDFhZOTk4XV1RJWBdeVk8XWlcW',
  },
  lens: 160,
});

module.exports = getBasearr;
"""


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


def install_len160():
    basearr_dir = resolve("rs-reverse/src/handler/basearr/index.js")
    if not basearr_dir:
        print("[SKIP] len160 适配器: rs-reverse 未安装 (先 npm install rs-reverse)")
        return False
    target = basearr_dir.parent / "len160.js"
    io.open(target, "w", encoding="utf-8", newline="").write(LEN160_JS)
    print(f"[PATCHED] len160 适配器: {target}")
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

    # 3. 站点D len160 适配器注入
    ok &= install_len160()

    # 4. makeCookie.js: 存储全量动态代码 (runTask 函数声明预提升用)
    makecookie_js = resolve("rs-reverse/src/makeCookie.js")
    ok &= apply(
        makecookie_js,
        [
            "const { code, $_ts, codemap } = coder.run();\n"
            "  gv.config.codemap = codemap;",
        ],
        "const { code, $_ts, codemap } = coder.run();\n"
        "  gv.config.codemap = codemap;\n"
        "  gv.config.code = code; // 站点D 修复: 全量动态代码 (runTask 函数声明预提升用)",
        "rs-reverse makeCookie 全量代码存储",
    )

    # 5. runTask.js: global_res 函数绑定优先 (消除崩溃类1)
    runtask_js = resolve("rs-reverse/src/handler/parser/common/runTask.js")
    ok &= apply(
        runtask_js,
        [
            "    const global_res = new Proxy({}, {\n"
            "      get(target, property, receiver) {\n"
            "        // 由于每个版本下标都会变，在解析cd值生成8位偏移数的时候只用到了cp2数组，因此这里只返回cp2，需要注意！\n"
            "        logger.debug(`global_res 获取下标： ${property}`);\n"
            "        return gv.cp2;\n"
            "      }\n"
            "    })",
        ],
        "    const global_res = new Proxy({}, {\n"
        "      get(target, property, receiver) {\n"
        "        // 框架原作者假设: 动态代码只用 global_res 取 cp2 (生成8位偏移数)。\n"
        "        // 站点D 新 VM 打破假设: 还通过 global_res 访问动态代码作用域的函数\n"
        "        // (如 _$no), 真实 VM 里 global_res 映射作用域绑定。\n"
        "        // 修复: 函数绑定优先 (缓存), 否则回退 cp2 (数字键偏移路径不变)。\n"
        "        if (typeof property === 'string' && /^\\d+$/.test(property)) {\n"
        "          return gv.cp2;   // 数字键直通 (偏移生成高频路径, 免 eval 开销)\n"
        "        }\n"
        "        if (property === 'then' || property === Symbol.toPrimitive || property === 'toString') {\n"
        "          return undefined;\n"
        "        }\n"
        "        const cacheKey = 'g_' + String(property);\n"
        "        if (global_res._cache[cacheKey] !== undefined) {\n"
        "          return global_res._cache[cacheKey];\n"
        "        }\n"
        "        try {\n"
        "          const v = eval(String(property));\n"
        "          if (typeof v === 'function') {\n"
        "            global_res._cache[cacheKey] = v;\n"
        "            return v;\n"
        "          }\n"
        "        } catch (e) { }\n"
        "        logger.debug(`global_res 获取下标： ${property}`);\n"
        "        return gv.cp2;\n"
        "      }\n"
        "    })\n"
        "    global_res._cache = {};",
        "rs-reverse runTask global_res 函数绑定",
    )

    # 6. runTask.js: 函数声明预提升 (v7 词法扫描 + var 提升, 消除崩溃类2/3)
    ok &= apply(
        runtask_js,
        [
            "  ].join(', ');\n"
            "  eval(`var ${vars};${codemap.commonFunc}`)",
            "  eval(`var ${vars};${codemap.commonFunc};\\n${getHoistedFunctions()}`)",
        ],
        "  ].join(', ');\n"
        "  eval(`var ${vars};${codemap.commonFunc};\\n${getHoistedFunctions()}\\n${getHoistedVars()}`)",
        "rs-reverse runTask 函数声明预提升",
    )
    hoist_tpl = Path(__file__).parent / "_runTask_hoist_v7.tpl.js"
    if hoist_tpl.exists():
        hoist_code = io.open(hoist_tpl, encoding="utf-8").read().rstrip() + chr(10)
        text = io.open(runtask_js, encoding="utf-8").read()
        anchor = "function runTaskByUid"
        if anchor in text and "getHoistedVars" not in text:
            text = text.replace(anchor, hoist_code + anchor, 1)
            io.open(runtask_js, "w", encoding="utf-8", newline="").write(text)
            print(f"[PATCHED] rs-reverse runTask 提升器 v7 (词法扫描 + var 提升)")
        else:
            print(f"[OK] runTask 提升器: 已打过或版本不同")
    else:
        print(f"[SKIP] 提升器模板缺失: {hoist_tpl}")

    if not ok:
        sys.exit(1)
    print("补丁完成")


if __name__ == "__main__":
    main()
