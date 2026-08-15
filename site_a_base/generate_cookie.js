/**
 * generate_cookie.js — sdenv 补环境生成瑞数 Cookie（通用模板）
 *
 * 基于站点D（药品监管部门）方案，参数化支持任意瑞数站点。
 *
 * ★ 关键突破: 阻止 location.replace 重定向，让 VM 有足够时间完成 cookie 生成
 *    → 导出完整 cookieJar（含 O+S+P 等所有 cookie）
 *    → 配合 curl_cffi Chrome TLS 使用
 *
 * 用法:
 *   node generate_cookie.js --url=<目标URL> --wait=10 --output=<FILE>
 */
const fs = require('fs');
const path = require('path');
const { jsdomFromUrl, logger } = require('sdenv');

// 抑制 sdenv 日志
logger.level.level = 50000;

// === 参数解析 ===
const args = {};
process.argv.slice(2).forEach(arg => {
  const m = arg.match(/^--(\w[\w-]*)=(.*)$/);
  if (m) args[m[1]] = m[2];
});

const DEFAULT_URL = Buffer.from('aHR0cHM6Ly93d3cubHp1LmVkdS5jbg==', 'base64').toString('utf8');
const TARGET_URL = args.url || process.env.RS_TARGET_URL || DEFAULT_URL;
const WAIT_SEC = parseInt(args.wait || '8');
const OUTPUT_FILE = args.output || path.join(__dirname, 'output', '_cookie.txt');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

function log(msg) {
  process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

async function generateCookies(url, waitSec) {
  log(`目标: ${url}`);
  log(`等待: ${waitSec}s`);
  log(`输出: ${OUTPUT_FILE}`);

  return new Promise((resolve, reject) => {
    let resolved = false;

    jsdomFromUrl(url, {
      strictSSL: false,
      userAgent: UA,
      runScripts: 'dangerously',
      resources: 'usable',
      browserType: 'chrome',
      beforeParse(window) {
        // try/catch 包裹 timer 回调 — 缺失 API 不中断回调链
        const st = window.setTimeout;
        const si = window.setInterval;
        window.setTimeout = function (fn, d) {
          return st(function () { try { fn(); } catch (e) {} }, d);
        };
        window.setInterval = function (fn, d) {
          return si(function () { try { fn(); } catch (e) {} }, d);
        };

        // ★ 阻止 redirect，让 VM 在当前上下文完成 cookie 生成
        window.location.replace = function (newUrl) {
          log(`[BLOCKED] location.replace → ${newUrl}`);
        };
      },
    }).then(dom => {
      const win = dom.window;
      const cookieJar = dom.cookieJar;

      // 记录 cookie 生成过程
      let lastLen = 0;
      const checkInterval = setInterval(() => {
        const docCookie = win.document.cookie;
        if (docCookie.length !== lastLen) {
          lastLen = docCookie.length;
          log(`document.cookie: ${docCookie.length} chars`);
        }
      }, 1000);

      // 等待 VM 完成
      setTimeout(() => {
        if (resolved) return;
        resolved = true;
        clearInterval(checkInterval);

        const docCookie = win.document.cookie;
        const allCookies = cookieJar.getCookieStringSync(url);

        log(`完成!`);
        log(`  document.cookie: ${docCookie.length} chars`);
        log(`  cookieJar: ${allCookies.length} chars`);

        // 写入文件
        const outDir = path.dirname(OUTPUT_FILE);
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(OUTPUT_FILE, allCookies, 'utf-8');
        log(`  已写入: ${OUTPUT_FILE}`);

        win.close();
        resolve(allCookies);
      }, waitSec * 1000);
    }).catch(err => {
      if (resolved) return;
      resolved = true;
      log(`失败: ${err.message}`);
      reject(err);
    });
  });
}

// ===== 主入口 =====
(async function main() {
  process.stderr.write('='.repeat(60) + '\n');
  process.stderr.write('瑞数 sdenv 补环境 (redirect-blocked) — 大学高校通用\n');
  process.stderr.write('='.repeat(60) + '\n\n');

  try {
    const cookies = await generateCookies(TARGET_URL, WAIT_SEC);

    if (cookies) {
      // 输出到 stdout（供 Python 读取）
      process.stdout.write(cookies);
    }
    process.exit(cookies ? 0 : 1);
  } catch (err) {
    log(`FATAL: ${err.message}`);
    process.exit(1);
  }
})();
