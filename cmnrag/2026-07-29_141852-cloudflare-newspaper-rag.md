# 中国气象报 2026 年 7 月档案 Cloudflare RAG 实施计划

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 将已清洗的 510 篇 2026 年 7 月《中国气象报》稿件构建为一个默认私有、可按日期/版面/地区/栏目筛选、答案可回链原稿的 Cloudflare RAG 服务。

**Architecture:** 本地 Markdown 是唯一源数据；一个本地 TypeScript 导入器解析 frontmatter、校验并按自然段切块，经 Workers AI 生成嵌入后写入 Vectorize，同时把正文块和完整元数据写入 D1。Cloudflare Worker 的 `/query` 先做结构化过滤和混合召回（Vectorize 语义 + D1 FTS5 关键词），再用 reranker 重排，最后让 Workers AI 仅依据被召回的片段回答；响应附带稿件出处与证据片段。初版不做网页聊天界面、MCP、图片 OCR、知识反思或自动抓取，以免把一个月、510 篇稿件的可控项目过早做复杂。

**Tech Stack:** TypeScript、Cloudflare Workers、Workers AI、Vectorize、D1（SQLite/FTS5）、Wrangler、Vitest、node:fs 本地导入器。

---

## 1. 已核实的起点

- 源目录：本项目 `cmnrag/202607*/**/*.md`（数据已从 VPS `/opt/data/ragtest` 迁至项目 `cmnrag/` 并纳入 Git）
- 范围：21 个刊期、510 篇稿件、约 588,070 个字符；全部已有 YAML frontmatter。
- 实例文件已确认包含：`title`、`author`、`date`、`page`、`theme`、`edition_type`、`headline`、`column`、`region`；图片新闻另有 `image: true`。
- 本机已具备 Node `v22.22.3`、npm `10.9.8`、Wrangler `4.115.0`；当前 Cloudflare 账户令牌已登录（不在代码、日志或仓库中写入令牌）。
- `cmnrag/` 是 Git 仓库（remote: bladescepter/cmnrag）。实现项目应新建独立 Git 仓库（见 Task 1），绝不移动、改写或污染档案目录。

## 2. 核心判断

不要照教程原样直接部署：教程的 `bge-base-en-v1.5` 面向英语，且其 `/load` 端点更适合演示数据。我们的语料和检索问题均为中文新闻；公开可调用的加载接口也会造成重复写入、数据污染或成本失控。

### 初版确定的技术取舍

| 项目 | 选择 | 理由 |
|---|---|---|
| 语料源 | 本地清洗后的 Markdown | 保持现有文件为唯一真源；可复跑、可审计 |
| 嵌入模型 | `@cf/baai/bge-m3` | Cloudflare 标为多语言模型，适合中文；60k token 上下文，单价 $0.012/M 输入 token |
| 向量维度 | 在建索引前通过一次模型 smoke test 实测并固化 | Vectorize 维度必须与嵌入输出严格一致；不能从教程的 768 维照抄 |
| 向量库 | Vectorize（cosine） | 语义召回与结构化 metadata 过滤 |
| 正文与关键词索引 | D1 + FTS5 | 保存可引用的正文块，并补足人名、地名、文件名、专有名词的精确检索 |
| 初版检索 | 向量 top 20 + FTS top 20 → RRF 融合 → `bge-reranker-base` 前 12 → 取前 6 | 新闻检索既要语义，也常需要精确匹配；先小规模验证再定阈值 |
| 生成模型 | 首选 `@cf/meta/llama-3.1-8b-instruct-fp8-fast` | 成本和延迟显著低于教程的 70B；以带出处、拒绝无依据回答为主。若评测显示中文归纳不足，再比较 `@cf/google/gemma-4-26b-a4b-it` |
| 访问方式 | 仅私有 API：Bearer query secret；默认不启用宽松 CORS | 报纸档案、内部检索需求不应裸露为公开接口 |
| 导入 | 本地 CLI 直接调 Cloudflare API；不提供公网 `/load` | 导入权限只留在操作环境，支持幂等重跑与增量更新 |
| 暂不采用 | R2、图片理解、MCP、多租户、知识反思、前端 UI | 510 篇文本稿件不需要这些；它们不是首版成败条件 |

### 成本边界

Cloudflare 当前文档显示：Workers AI 免费额度为每天 10,000 Neurons，超额需 Workers Paid；Vectorize Free 包含每月 5M 存储维度、30M 查询维度。实际向量数须以切块结果为准。即使按 2,000 块、1,024 维估算，存储约 2.05M 维，仍在免费存储额度内；但 Vectorize 的查询计费会随“索引全部向量 × 每次查询维度”增长，不能把 510 篇档案的演示规模误当成无限量免费服务。实施时以实际 chunks 与 Cloudflare 控制台用量为准。

## 3. 数据契约

### 3.1 稿件主键与版本

`article_id = sha256(relative_path)`，其中 `relative_path` 相对本项目 `cmnrag/`，例如：

```text
20260729/一版/01-持续提升防灾减灾救灾能力切实保障人民群众生命财产安全.md
```

- 该 ID 稳定、可从来源路径复算，避免中文标题重名冲突。
- `source_sha256 = sha256(完整 Markdown 原文)`；导入器只更新哈希变化的稿件。
- 每块 ID：`${article_id}:${chunk_index}`；再导入使用 upsert，禁止“清空后重灌”。
- 删除仅由显式 `--delete-missing` 预演清单并经人工确认后执行；首版不启用该参数。

### 3.2 D1 表

`articles`：一稿一行，保存 `article_id`、`source_path`、`source_sha256`、标题、作者、日期、page、theme、edition_type、headline、image、column、region、完整正文、导入时间。

`chunks`：一块一行，保存 `chunk_id`、`article_id`、`chunk_index`、`chunk_total`、`content`、`content_sha256`。

`chunks_fts`：D1 FTS5 虚表，索引 `title`、`author`、`content`、`column`、`region`，用于关键词召回；它是检索索引，不作为正文真源。

`ingest_runs`：保存导入批次、源文件数、成功/失败/跳过数、开始/结束时间和失败原因。任何单稿失败都写出明确结果并以非零退出，禁止静默漏稿。

### 3.3 Vectorize metadata（只放过滤和回显所需字段）

每个向量携带：

```ts
{
  articleId, chunkId, date, page, theme, editionType,
  headline, image, column, region, author, source: "中国气象报",
  chunkIndex, chunkTotal
}
```

创建 Vectorize 前先建立至多 10 个真正需要的 metadata index：`date`、`page`、`theme`、`editionType`、`headline`、`image`、`column`、`region`、`author`、`source`。

注意：Cloudflare 规定 metadata index 必须先于向量写入创建；日后补建的字段不会自动索引既有向量，必须重新 upsert。字符串索引的可过滤值只取前 64B，因此标题不作为 Vectorize 过滤字段，完整标题交给 D1 FTS5。

## 4. 分块与检索规则

### 4.1 分块

1. 用可靠 YAML parser 解析 frontmatter；正文从第二个 `---` 后开始。
2. 先跑 schema 校验：标题、日期、版面、版别、布尔字段、图片新闻标记及空字段规则必须符合现有资料规范。校验报告逐文件列出错误，不能擅自修原始稿。
3. 以自然段为边界，而非固定 token 硬切：
   - 正文不足 600 汉字：整篇一块；
   - 600–1,500：目标 500 汉字/块；
   - 1,500 以上：目标 400 汉字/块；
   - 超长单段只在句号、问号、叹号处切，必要时记录警告。
4. 每个嵌入文本前拼接检索头，而不是仅嵌正文：

```text
标题：{title}
作者：{author}
日期：{date}
版面：{page}
主题：{theme}
栏目：{column}
地区：{region}
正文：{chunk_content}
```

这能让“某作者写过什么”“某地的防雷报道”“某栏目”获得有效语义召回；数据库仍保存未拼接的正文块，避免回答时重复元数据。

### 4.2 查询接口

`POST /v1/query`

请求：

```json
{
  "question": "7月有哪些关于气象预警成功避险的案例？",
  "filters": {
    "date_from": "2026-07-01",
    "date_to": "2026-07-31",
    "page": ["一版", "二版"],
    "region": ["河北省"],
    "theme": ["综合"],
    "author": [],
    "headline": null,
    "image": null
  },
  "mode": "answer"
}
```

- `mode: "search"`：仅返排序后的命中与摘录，便于检索质量调试，不调用生成模型。
- `mode: "answer"`：向量和 FTS 召回并重排后生成答案。
- 过滤参数全部可选、严格白名单校验；`date_from/to` 转为 ISO 日期字符串区间；`page/theme/region/author` 多选在 Worker 端转换为 Vectorize `$in` 或精确 D1 条件。
- 未设过滤时搜索整个 7 月语料；不默认凭空添加地区或版面限制。

### 4.3 回答约束与响应

系统 prompt 固定要求：

- 只能依据 `<sources>` 中证据回答；不得把模型常识、推断、原文外的时间事实伪装为档案事实。
- 证据不足时明确写“现有档案未提供足够依据”，并给出已检索到的接近内容；不编造。
- 事实性段落末尾使用 `[1]`、`[2]` 证据编号；不捏造作者、日期、数字。
- 回答中文；用户没有问分析时直接回答。

响应至少包含：`answer`、`sources[]`（articleId、title、date、page、author、region、chunk excerpt、score、source_path）、`retrieval`（vector/fts/rerank 各阶段计数与耗时）、`request_id`。不把全文正文、查询密钥或内部错误栈返回客户端。

## 5. 分步执行计划

### Task 1：建立隔离项目与不可变基线

**Files:**
- Create: `/opt/data/china-meteo-rag/`
- Create: `/opt/data/china-meteo-rag/README.md`
- Create: `/opt/data/china-meteo-rag/.gitignore`
- Create: `/opt/data/china-meteo-rag/package.json`

**Steps:**
1. 在独立目录初始化 Git 与 TypeScript Workers 项目；不在 `cmnrag/` 执行初始化或写入任何文件。
2. `.gitignore` 排除 `.dev.vars`、`.env*`、`node_modules/`、本地报告和导出文件；提交 `.dev.vars.example`，但绝不提交真实令牌或 secret。
3. 写 README，明确源目录只读、导入命令、私有 API 边界和禁止公网 `/load`。
4. 生成只读 manifest：相对路径、source SHA-256、frontmatter 校验状态、正文字符数。
5. 验证：manifest 文件数必须为 510；任何解析/校验失败使命令退出码为 1；输出按文件列错误。

### Task 2：实现并测试 Markdown 解析、schema 校验与分块

**Files:**
- Create: `src/ingest/parseArticle.ts`
- Create: `src/ingest/chunkArticle.ts`
- Create: `src/ingest/validateArticle.ts`
- Create: `test/parseArticle.test.ts`
- Create: `test/chunkArticle.test.ts`
- Create: `test/validateArticle.test.ts`

**Steps:**
1. 从真实档案中抽取代表性 fixture：简讯、长通讯、图片新闻、空栏目、无地区、多个作者、含中文引号的标题；fixture 可复制到项目 test 目录，但不得改动源稿。
2. 先写失败测试：解析 frontmatter/正文边界、所有必填字段、`image` 默认 false、段落不截断、stable chunk ID、超长段落句界切分。
3. 实现最小解析与校验；日期、page、edition_type、boolean 类型必须严格。
4. 实现自然段分块和检索头拼接；测试每块正文完整覆盖，非必要不重叠。
5. 执行 `npm test` 和完整语料的 `npm run validate:corpus`；留存 CSV/JSON 校验报告。

### Task 3：先用真实语料完成质量评测集

**Files:**
- Create: `eval/golden-queries.jsonl`
- Create: `eval/README.md`
- Create: `scripts/run-eval.ts`

**Steps:**
1. 人工制作至少 30 个问题，覆盖：标题复现、作者、地区、日期范围、栏目、专题版、专有名词、跨稿归纳、无答案问题。
2. 每题明确期待的 `article_id`（至少一个）、可选 filter、答案验收点；例如“谁/哪地/何时/哪篇”要有可核对的原稿。
3. 将问题按 retrieval 与 generation 分层评测：
   - Retrieval：Recall@10、MRR@10、带 filter 的精确性；
   - Generation：引用是否真实、关键数字/名称是否与原文一致、无依据时是否拒答。
4. 这是模型和 topK 决策的依据；没有此集，不引入 reranker，也不声称“生产可用”。

### Task 4：创建 Cloudflare 数据资源（需用户明确批准后执行）

**Files:**
- Create: `wrangler.jsonc`
- Create: `migrations/0001_initial.sql`
- Create: `scripts/provision.sh`（仅输出计划命令；实际资源创建另以单独命令执行）

**Steps:**
1. 以一次实际 Workers AI embedding 调用测得 `bge-m3` 输出向量长度，记入 `src/config/models.ts`；再使用同一维度创建 `zgqxb-202607-bge-m3` Vectorize index（cosine）。
2. 创建上述 10 个 metadata indexes，然后才允许任何向量写入。
3. 创建 D1 数据库 `zgqxb-archive` 并应用 `0001_initial.sql`（含 FTS5 表与触发器/同步逻辑）。
4. 使用 Wrangler 绑定 D1、Vectorize、Workers AI；只在 Cloudflare secret 中设置 `QUERY_SECRET`，本地导入用 API Token 环境变量，不写入 `wrangler.jsonc`。
5. 先在空资源上运行 smoke test：写入 2 条固定向量/两块测试文本、带 metadata filter 查询、D1 FTS 查询、清除测试数据。验证失败即停止导入。

**Approval boundary:** 创建 D1/Vectorize、写入 Cloudflare secret、部署 Worker 都属于外部资源与凭证操作；本计划不执行，需用户明确批准。

### Task 5：实现幂等导入器与审计报告

**Files:**
- Create: `src/ingest/index.ts`
- Create: `src/ingest/d1.ts`
- Create: `src/ingest/vectorize.ts`
- Create: `src/ingest/report.ts`
- Create: `test/ingest.test.ts`

**Steps:**
1. CLI 参数：`--source <项目根>/cmnrag --month 202607 --dry-run`、`--article <relative-path>`、`--concurrency 2`；默认不提供删除功能。
2. 先 `--dry-run` 输出：文章数、预期块数、变化/新增/跳过的稿件清单、异常清单；不发出任何 Cloudflare 写请求。
3. 真实导入：逐篇事务化处理 D1，分批嵌入与 Vectorize upsert；单篇失败记录后最终返回非零。恢复时仅重试失败/变更文章。
4. 重新导入同一 manifest 应显示 `0 changed`，不得新增重复块或向量。
5. 导入结束生成 `reports/ingest-<UTC timestamp>.json`：510 篇合计、chunks、成功、跳过、失败、每篇耗时和 IDs；不得输出 token 或 secret。
6. 执行前抽样 20 篇逐条核对：D1 的 title/author/date/page/region 与源 Markdown 一致；Vectorize metadata 与 D1 一致。

### Task 6：实现安全的 Worker 查询管线

**Files:**
- Create: `src/worker.ts`
- Create: `src/query/validateRequest.ts`
- Create: `src/query/retrieveVector.ts`
- Create: `src/query/retrieveFts.ts`
- Create: `src/query/fuse.ts`
- Create: `src/query/rerank.ts`
- Create: `src/query/generate.ts`
- Create: `src/http/auth.ts`
- Create: `src/http/errors.ts`
- Create: `test/query.test.ts`
- Create: `test/auth.test.ts`

**Steps:**
1. 仅实现 `GET /health`、`POST /v1/query`；其他路径 404。`/health` 不泄露索引名、账号、版本以外的内部信息。
2. `POST /v1/query` 必须验证 `Authorization: Bearer <QUERY_SECRET>`；使用恒定时间比较；无效时统一 401。
3. 限制 JSON body（例如 16KB）、question 长度（例如 1–1,000 字）、filters 结构及数组长度；拒绝而不是隐式截断。
4. 对 query 进行 bge-m3 嵌入；Vectorize `topK=20` 且应用合法 metadata filter；D1 FTS `LIMIT 20`；RRF 融合；对最高 12 块调用 reranker，最终给生成模型 6 块。
5. 根据 IDs 从 D1 取正文和完整出处；绝不依赖 Vectorize metadata 保存完整正文。
6. 生成前把来源编号、标题、日期、版面、片段传入严格 prompt；执行来源引用完整性检查：答案中每一个 `[n]` 都应对应 sources 数组。
7. 开发环境单元测试覆盖：无 token、错误 token、恶意 filter、空问题、无命中、单召回路径失效、D1/Vectorize 结果去重、引用编号、模型超时。

### Task 7：本地、预发布与正式验证

**Files:**
- Create: `scripts/smoke-query.ts`
- Create: `docs/acceptance-checklist.md`
- Create: `docs/operations.md`

**Steps:**
1. `wrangler dev` 使用局部开发 secret；不使用生产 secret 做日志调试。
2. 在预发布 Worker 完整导入，运行 golden queries，输出 baseline 指标和每题来源清单。
3. 与三种策略做对照：Vector-only、Vector+FTS、Vector+FTS+reranker。以评测集的 Recall@10 与人工复核的引用准确率决定是否保留 reranker；若收益不足，删掉以降低成本和链路复杂度。
4. 抽取至少 10 个生成答案逐句与原稿核对：作者、时间、地点、数字、政策名称和结论都必须可回指。错误不能靠 prompt 粉饰，先定位召回/切块/元数据根因。
5. 记录实际 chunks、嵌入 neuron 用量、Vectorize 存储/查询维度、p50/p95 响应时间；设置 Cloudflare Dashboard 的用量观察。
6. 通过下列上线门槛后，才部署正式 Worker：
   - corpus validation：510/510 成功；
   - import：0 个未解释失败；
   - golden retrieval Recall@10 ≥ 0.90；
   - 30 个评测答案中引用指向正确率 100%；
   - 无答案题不编造具体稿件事实；
   - 未带 token 的请求一律 401；
   - 重新导入不产生重复数据。

### Task 8：上线后运维与扩展决策

**Files:**
- Create: `docs/runbook.md`
- Create: `docs/data-retention.md`

**Steps:**
1. 月度增量导入只针对新稿或哈希变化稿；每次先 `--dry-run`，再导入，最后跑一小组回归题。
2. 增加来源版本和可复现导入报告；遇到源 Markdown 修订，按 article_id 更新 chunks/向量，不以文件名猜测。
3. 当语料扩展到多月、实际搜索量或评测显示需要时再评估：Cloudflare Access、Web UI、MCP、R2 附件、图片 OCR、自动化 cron、跨月 filters。
4. 不在没有独立评测、访问控制和用量数据前启用给第三方的公开接口。

## 6. 验收问题样例（评测集起点）

| 类别 | 问题 | 预期验证 |
|---|---|---|
| 地点/事实 | “7月29日李强在何地调研慰问，围绕哪些防灾减灾环节提出要求？” | 命中唐山稿；出处、唐山市、机制环节均可回原文 |
| 作者 | “邹伟在7月写了哪篇报道？” | 作者 metadata + FTS + 语义检索均能定位 |
| 专题 | “围绕台风‘巴威’有哪些报道？” | 多篇同主题稿，不只返回一篇 |
| 结构化筛选 | “只看二版的气象服务报道” | page filter 在检索前生效 |
| 地区 | “湖北有哪些气象预警联动案例？” | region filter 与正文精确地名均可用 |
| 无答案 | “7月关于2027年台风的报道有哪些？” | 不捏造，明确语料无依据 |

## 7. 风险、边界与待确认事项

1. **版权与访问边界：** 这是报纸全文档案。即使 Worker 只由自己使用，也应默认私有；对外开放、分享全文或面向公众检索之前必须先确认授权与单位要求。
2. **模型质量：** `bge-m3` 是基于语言匹配与官方多语言定位的首选，不是未经评测的结论。用 golden set 与 `qwen3-embedding-0.6b` 做 A/B 后可调整；一旦换模型必须新建匹配维度的索引并全量重嵌入，不能混用向量。
3. **答案可信性：** RAG 只能降低幻觉，不能自动确保事实正确；来源回链和评测是首版必需品。
4. **Cloudflare 服务成本/额度：** 免费 Workers AI 每日 10,000 Neurons 用完后请求会失败；正式使用前需要确认账户的 Workers 计划和预期日查询量。
5. **发布日期范围：** 当前计划仅覆盖 `cmnrag/202607*/` 的 2026 年 7 月 510 篇；以后扩展月份必须走相同增量导入和回归评测，不与本次混在一起。

## 8. 执行前需要的明确决定

本计划已按“私有、文本优先、能审计”的默认值设计。实际开始前只需确认：

- 是否同意在 Cloudflare 账户中创建 D1、Vectorize、Worker，并向这些服务写入 510 篇已清洗文本？
- 访问目标是否只限你本人（Bearer secret），还是后续需要桌面/Web 聊天界面或 MCP 接入？
- 是否接受首版按 `bge-m3 + D1 FTS5 + reranker` 实施，并以 30 题评测结果决定保留/调整？

## 9. 参考依据

- Cloudflare Vectorize metadata filtering：metadata index 必须先建；最多 10 个 metadata index；每向量 metadata 最大 10KiB；字符串过滤索引前 64B。
- Cloudflare Workers AI：`bge-m3` 为多语言 embedding，价格 $0.012/M 输入 token；`bge-reranker-base` 价格 $0.003/M 输入 token。
- Cloudflare Vectorize 定价：Free 包含 5M 存储维度与 30M 查询维度/月；计量按索引规模与查询维度计算。
- 教程和参考实现：freeCodeCamp 的 `rag-tutorial-simple` 适合最简通路；`vectorize-mcp-worker` 的混合检索、reranking、metadata filtering 提供后续设计参考，但其多租户、MCP、图像、reflection 不纳入本期首版。
