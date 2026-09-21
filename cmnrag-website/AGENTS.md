# cmnrag-website/AGENTS.md — Cloudflare Worker

本目录是 `china-meteo-rag` Worker。仓库级数据抓取、审核、作者/栏目入库和档案上线流程以根目录 `../AGENTS.md` 为准；本文件只保留 Worker 相关规则。

## 密钥

- 密钥文件在仓库根目录：`../.env`，即 `/home/blade/Projects/cmnrag/.env`。
- 导入脚本使用 `CLOUDFLARE_RAG_API_TOKEN`。
- Wrangler 非交互部署使用 Workers 权限 token：
  ```bash
  set -a; . ../.env; set +a
  export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_RAG_API_TOKEN"
  ```
- 不打印、提交或写日志记录 token；不要使用仅用于 blog-purge 的低权限 token。

## Worker 基本信息

- 名称：`china-meteo-rag`
- 入口：`src/index.ts`
- 域名：`https://cfzx.xiyuan.wiki`
- 绑定：`DB`（`zgqxb-archive`）、`PB_DB`（`paiban`）、`VECTORIZE`（`zgqxb-bge-m3`）、`AI`、`ASSETS`
- 修改 `wrangler.jsonc` 的绑定后必须执行 `npx wrangler types`。

## 部署命令

用户明确确认上线后，在本目录执行：

```bash
set -a; . ../.env; set +a
export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_RAG_API_TOKEN"
npx wrangler deploy --dry-run
npx wrangler deploy
```

新期档案上线前，必须先按根目录流程完成 D1 导入和 Vectorize 向量导入。数据导入失败时停止，不得只报告 Worker 部署成功。

新期档案或仅作者/栏目库更新不默认执行 `npm test`、`npm install` 或其他无关检查；只有用户要求或修改了需要验证的 Worker 源码时才执行。

## 常用命令

```bash
npm run dev
npx wrangler dev --remote
npx wrangler types
npm run build:paiban
```

排班前端改动后运行 `npm run build:paiban`；`src/paiban` 后端改动无需单独构建。

## Cloudflare 文档

涉及 Workers、D1、Vectorize、Workers AI、资产或限额的变更，先查官方文档：

- <https://developers.cloudflare.com/workers/>
- <https://developers.cloudflare.com/d1/>
- <https://developers.cloudflare.com/vectorize/>
- <https://developers.cloudflare.com/workers-ai/>
