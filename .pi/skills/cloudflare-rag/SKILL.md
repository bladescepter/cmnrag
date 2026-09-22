---
name: cloudflare-rag
description: Build production RAG systems on Cloudflare Workers with D1, Vectorize, and Workers AI. Structured metadata filtering + vector semantic search + LLM generation.
version: 1.1.0
author: 千早爱音 + 陆西园
tags: [cloudflare, workers, rag, d1, vectorize, workers-ai, retrieval]
triggers:
  - build a RAG system
  - cloudflare RAG
  - vectorize search
  - D1 with vector search
  - hybrid retrieval
  - RAG with metadata filters
---

# Cloudflare Workers RAG

Production patterns for building RAG systems on Cloudflare Workers using D1 (structured metadata), Vectorize (semantic search), and Workers AI (embeddings + generation).

## Architecture

```
User question + metadata filters
        │
        ▼
D1 — apply structured filters (region, page, column, date, etc.)
        │  WHERE column_name = ? AND region LIKE ?
        │  Only returns matching article_ids
        ▼
Vectorize — semantic search restricted to filtered article_ids
        │  topK=12 (filtered) or topK=50 (unrestricted)
        │  returnMetadata="all" only when topK ≤ 50
        ▼
D1 — lookup chunks by vector_id + filter by eligible article_ids
        │  Join chunks → articles to get full metadata
        ▼
LLM — Workers AI generation with grounded prompt
        │  Cite sources as [1], [2], etc.
        ▼
JSON response with answer + source list
```

## D1 Query Pitfalls

### 1. LIKE with long Unicode → SQLITE_ERROR

`LIKE '%长栏目名含引号、顿号等%'` on D1 fails with `LIKE or GLOB pattern too complex`. Use `instr()` instead:

```sql
-- ❌ Fails on long Unicode values
column_name LIKE ? ESCAPE '\'
-- ✅ Works at any length
instr(column_name, ?) > 0
```

- `instr()` treats the user input as literal text — no wildcard escaping needed
- `%`, `_` are just regular characters, not LIKE wildcards
- Use for all user-supplied partial-match filters (column, theme, region, author)

### 2. IN clause with too many parameters → SQLITE_ERROR

When joining vector results with an article_id filter, passing hundreds of article IDs into the IN clause causes `too many SQL variables`. Solution: skip the IN clause when the eligible set is the entire corpus (no filters applied):

```ts
const articleFilter = eligibleIds.length < 200
  ? ` AND c.article_id IN (${eligibleIds.map(() => "?").join(",")})`
  : "";
```

## Vectorize Query Limits

| Mode | max topK | Use case |
|------|---------|----------|
| `returnMetadata: "all"` | **50** | Return all metadata fields with each vector |
| `returnMetadata: "indexed"` | 100 | Return only indexed (filterable) metadata fields |
| `returnValues: true` | 50 | Return the actual vector values |

If no filters are applied (searching the full corpus), use `topK=50` with `returnMetadata="all"`. This is sufficient — only the top 6 results are passed to the LLM after deduplication.

When filters narrow the eligible set to ≤20 articles, use `topK=20`; otherwise use `topK=50` with `returnMetadata="all"`.

## Reranking and adaptive evidence

Use a two-stage retrieval pipeline for generated answers. Vector similarity is only coarse recall; it should not determine final evidence order by itself.

```text
D1 metadata / keyword scope
  → Vectorize rough recall (topK 20 for small scopes, 50 otherwise)
  → D1 fetch candidate chunks
  → deduplicate to article-level candidates (keep the highest-ranked chunk per article)
  → @cf/baai/bge-reranker-base rerank up to 20 article candidates, return top 12
  → LLM context: all if ≤6 articles, otherwise top 8
  → show those as “主要来源”; do not imply they are exhaustive
```

Workers AI reranker model: `@cf/baai/bge-reranker-base` ($0.0031 / million input tokens). It accepts `query`, `contexts`, and `top_k`, returning ranked context IDs plus scores. Regenerate Worker types after model-binding changes; if generated type declarations omit `query`, preserve the documented API shape with a narrow input cast rather than altering the request payload.

Do not feed all retrieved chunks to the generation model. Extra context raises noise, citation ambiguity, latency, and cost. For broad, month-scale synthesis, use grouped/clustered summaries and a second synthesis pass instead of merely increasing evidence count.

## Frontend state pitfall

Do not name an input or button `reset` inside a form if client code calls `form.reset()`: named form controls shadow the native method, producing `TypeError: form.reset is not a function`. Call `HTMLFormElement.prototype.reset.call(form)` or avoid the conflicting name. After a reset, explicitly clear programmatically-set facet inputs and reset pagination / chat scope state.

## Metadata Filtering

Vectorize supports string metadata filters via `$in` operator, but string-index values are limited to the first **64 bytes**. Long Chinese column/theme names are truncated. **Do not rely on Vectorize metadata filters for long-string exact matching.**

Use D1 for structured metadata filtering, then pass only the matching article_ids to Vectorize:

```ts
// Step 1: D1 filters
const eligible = await DB.prepare(`SELECT article_id FROM articles WHERE ...`).all();
const eligibleIds = eligible.results.map(r => r.article_id);

// Step 2: Vectorize search within eligible set
const filter = eligibleIds.length <= 20
  ? { articleId: { $in: eligibleIds } }
  : undefined;
const matches = await VECTORIZE.query(queryVector, { topK: filter ? 12 : 50, filter });
```

Requires creating a metadata index on the Vectorize index:
```
npx wrangler vectorize create-metadata-index <index-name> --property-name=articleId --type=string
```

## Counting ≠ Summarization

RAG systems must distinguish two question types:

| Type | Example | Approach |
|------|---------|----------|
| **Counting** | "有多少篇关于妈祖的报道？" | D1 `COUNT(*)` with keyword/structured filter |
| **Summarization** | "这些报道反映了哪些做法？" | Vectorize semantic search + LLM generation |

Guard the AI endpoint against counting questions with a regex check:

```ts
if (/有[多几]少篇|总共|统计|数量|多少[篇条则张章]|几篇|几则|几张|几版/.test(question)) {
  return { answer: "请使用检索条件获取精确数量。AI 仅依据当前检索到的部分来源做归纳。" };
}
```

Also add a prompt-level instruction: "绝不能回答'共有X篇'这类精确计数问题。如果问题涉及数量，回答'请使用上方的检索框获取精确数量'。"

## Chunking Strategy

For Chinese news articles (avg. ~900 chars):

| Article length | Strategy |
|---------------|----------|
| ≤600 chars (short news, photo captions) | One chunk, intact |
| 600–1500 chars (standard reports) | Split by paragraphs at ~1000 chars |
| ≥1500 chars (long features) | ~1000 chars per chunk, 100–150 char overlap at boundaries |

Split at sentence boundaries (。！？) within paragraphs.

Each chunk stores:
- Chunk text + SHA256
- Vector ID (SHA256 of articleId:chunkIndex — stable across re-imports)
- Embedding model name
- Article metadata in the parent `articles` table

## Deployment Checklist

1. Create D1 database and run migrations
2. Create Vectorize index with matching dimensions (`bge-m3` = 1024)
3. Create metadata indexes on Vectorize for filterable fields
4. Deploy Worker with bindings: DB (D1), VECTORIZE (Vectorize), AI (Workers AI), ASSETS (static files)
5. Ingest data: parse → upsert articles → chunk → embed → upsert vectors
6. Configure custom domain via Cloudflare DNS

## cmnrag 资料上线快路径（D1 + Vectorize + Worker）

适用于 `cmnrag/` 新增或修订资料，以及审核后作者/栏目白名单的发布。**只有用户明确确认“上线/部署”后，才执行实际 deploy。**

### 1. 固定目录和凭证（先做，不能试错）

在仓库根目录用 bash/Git Bash 执行；`.env` 在仓库根目录，不在 `cmnrag-website/`：

```bash
cd C:/Users/blade/OneDrive/DEV/cmnrag
set -a && source .env && set +a
test -n "${CLOUDFLARE_RAG_API_TOKEN:-}" || { echo "CLOUDFLARE_RAG_API_TOKEN is required" >&2; exit 1; }
# 资料导入脚本读取 CLOUDFLARE_RAG_API_TOKEN；Wrangler 读取 CLOUDFLARE_API_TOKEN。
export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_RAG_API_TOKEN"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-6af7ecfe8e736f150bae5089463f9293}"
cd cmnrag-website
```

- 不要直接使用 `.env` 中可能权限较低的 `CLOUDFLARE_API_TOKEN`；本项目发布统一把有 Workers 权限的 `CLOUDFLARE_RAG_API_TOKEN` 映射给 Wrangler。
- 不打印 token，也不要在错误排查时输出完整环境变量。
- 任一步骤报错先停止，回到本节检查 cwd 和 token；不要换目录、换 token 盲目重试。

### 2. 审核结果入库

最终人工审核完成且用户确认“作者、栏目入库”后：

1. 以本地 Markdown frontmatter 为准，直接提取缺失作者并追加到 `scripts/fetch_epaper.py` 的 `KNOWN_AUTHORS`；将本期实际版面图确认过的栏目追加到 `KNOWN_COLS`。
2. 已确认的字段不再重复跑抓取、OCR 或视觉识别；用户明确修正只改对应 Markdown（及待办清单），不擅自改其他字段。
3. 用 `git diff --check` 做低成本格式检查，然后继续远程导入。

### 3. 远程导入和向量更新

从 `cmnrag-website/` 执行，**限定本次日期**，不要扫描整月或全库：

```bash
CMNRAG_DATES=YYYYMMDD npx tsx scripts/import-archive.ts && \
CMNRAG_DATES=YYYYMMDD npx tsx scripts/ingest-vectors.ts
```

`CMNRAG_MONTHS=YYYYMM` 仅用于明确要求的整月批处理；未提供日期或月份范围时脚本直接拒绝运行。

先确认导入脚本输出 JSON（`articles`/`changed`/`skipped`，无 error），再确认向量脚本完成（`chunks` 和最终 JSON）。第一步失败时不得运行第二步。两者都成功后，D1 元数据与 Vectorize 数据已经在线生效。

纯资料/frontmatter/白名单更新不需要为此强制跑整套 `npm test`；只有 Worker 源码、前端资源或配置发生变化时才跑测试。修改 `wrangler.jsonc` 绑定时先运行 `npx wrangler types`；排班前端变更时先运行 `npm run build:paiban`。

### 4. Worker dry-run 和部署

如果 Worker 源码、前端资源或绑定发生变化，或用户明确要求重新部署，从同一个已加载凭证的 `cmnrag-website/` cwd 执行：

```bash
npx wrangler deploy --dry-run
```

dry-run 成功且用户已明确授权后，**立即**执行实际部署：

```bash
npx wrangler deploy
```

不要在未加载 `.env`、未映射 RAG token 或错误 cwd 下运行 Wrangler。仅资料更新时不需要重复部署 Worker；但用户明确说“上线/部署”时仍按本节先 dry-run、后 deploy。

### 5. 最小验收

只做一个公开健康检查并记录发布版本；不要再写一条未经核对的手工 D1 API URL 来“验证”：

```bash
curl -fsS https://cfzx.xiyuan.wiki/health
```

导入脚本的成功 JSON 是 D1/Vectorize 写入结果，Worker deploy 的 version ID 加 `/health` 的 `{"status":"ok"}` 是发布验收依据。确需手工查 D1 时，必须使用非空的 `CLOUDFLARE_ACCOUNT_ID` 和完整路径 `.../client/v4/accounts/<account_id>/d1/database/<database_id>/query`，不得让空变量拼出 `/accounts/d1/...`。

### 6. 完成条件

一次上线只需保留：审核后的本地数据、导入 JSON、向量完成 JSON、dry-run 结果（如适用）、deploy version ID（如适用）和 health 响应。不要在成功后追加无必要的全库测试、重复导入、重复部署或额外查询。

## Common Errors

| Error | Root cause | Fix |
|-------|-----------|-----|
| `LIKE or GLOB pattern too complex` | Long Unicode pattern in D1 LIKE clause | Use `instr()` instead |
| `too many SQL variables` | Large `IN (...)` clause | Skip clause for unrestricted queries |
| `VECTOR_QUERY_ERROR: max top K is 50, but got 100` | `returnMetadata=all` with topK > 50 | Use topK ≤ 50 |
| `ai_unavailable` | Any caught error in generation pipeline | Check `wrangler tail` for actual error |
