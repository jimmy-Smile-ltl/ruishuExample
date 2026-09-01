# epub — 专利公布公告（CNIPA 同族 WAF 第二站，202 挑战变体）

**站点**: `aHR0cDovL2VwdWIuY25pcGEuZ292LmNu`（base64，解码见父 README）
与检索站（父目录）同族瑞数 WAF，**免登录**，专利公告数据全量可爬。

**状态 (2026-08-15 双路线跑通，2026-08-31 复测仍通)**:

| 方案 | 结果 | 用途 |
|------|------|------|
| sdenv 链式（`spider_sdenv.py`） | ✅ 202 → VM 出 P-cookie (285c, 4.8s) → 200（08-31 复测 17.3s） | WAF 本体验证 / 首页 / 首次搜索 |
| CDP RPC（`rpc_spider.py`） | ✅ 挑战 9.2s → 翻页 10/10，~3s/页（08-31 复测） | **生产爬虫**（全量翻页） |

## 快速启动

```bash
pip install curl_cffi websocket-client psutil
python spider_sdenv.py          # sdenv 链式验证（复用父目录 generate_cookie.js）
python rpc_spider.py 石墨烯      # RPC 生产爬虫（需本机 Chrome）
```

## 与检索站的差异（为什么有第二个子文件夹）

- **挑战页状态码是 202**（检索站 412）；且真实 200 页面头部常内嵌 `$_ts` 刷新块，
  `is_challenge()` 必须兼容"200 小页面含 $_ts"才算挑战页。
- **O-cookie 名每轮随机**（`NOh8RTWx6K2dS`/`T` 对），不要硬编码。
- **翻页 AJAX (`/Dxb/PageQuery`) 需要瑞数动态 token**（页面 XHR hook 自动附加），
  纯 curl 无 token → 400。所以生产走 CDP RPC（浏览器原生过挑战 + token 自动生成）。

## RPC 生产爬虫关键坑 (2026-08-15 实测)

1. **PageQuery 只接受顺序翻页**: 跳页/改页大小/改显示模式全部 400 —
   这些操作清空 `searchAfter` 游标（服务端要求 = 上一页末条的 公布日;申请号）。
   每页固定 3 条（服务端限制）。
2. **点击「下页」按钮 > 直接调 to_page()**: 请求逐字节一致但直接调用偶发 WAF 400
   （10.2s 拖慢后空 400）；点击 `.topage .next_page` 路径稳定 200。
3. 断点续爬: `output/{关键词}/_checkpoint.json` + `page_N.json` + `all.json`。
4. 搜索结果页含 `debugger;` 语句 — CDP 不启用 Debugger 域则不触发，无影响。
5. **首跑失败先 `--fresh`**: 持久 profile 残留旧状态会导致挑战超时（08-31 实测:
   旧 profile 90s 不过 → `--fresh` 9.2s 过）。翻页间歇 400 时脚本内置 12s 重试。

## 接口速查

| 端点 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 首页 (202 挑战) |
| `/Dxb/IndexQuery` | POST | 搜索: `searchStr` + 类型勾选 + antiforgery token |
| `/Dxb/PageQuery` | POST | 翻页 AJAX: `searchCatalogInfo.*`(31 字段) + `searchAfter` 游标 + URL 瑞数 token |

ASP.NET Core + antiforgery（`__RequestVerificationToken` + `.AspNetCore.Antiforgery.*` cookie）。
石墨烯示例: `total_item: 32222` 条。
