# AGENTS.md — cmnrag（中国气象报稿件资料库）

《中国气象报》档案检索系统：结构化稿件资料库（Markdown 真源）+ Cloudflare Workers 检索服务 + AI 综合问答。线上入口 <https://cfzx.xiyuan.wiki>。产品功能与数据范围详见 `README.md`。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `cmnrag/` | **数据真源**：`YYYYMM/YYYYMMDD/版面/序号-标题.md`，一篇稿件一个 Markdown + YAML frontmatter |
| `cmnrag/FRONTMATTER.md` | 检索字段的权威定义（`column`/`region`/`theme` 等边界），改检索逻辑前必读 |
| `cmnrag-website/` | Cloudflare Workers 服务：源码（`src/`）+ 测试（`test/`）+ 迁移（`migrations/`）+ 静态前端（`public/`）。含三个模块：资料库（`src/archive`、`src/ai`）、排班表（`src/paiban` + `paiban-web/` + `paiban-data/`）、校对 |
| `scripts/` | 电子报抓取/清洗 Python 脚本（fetch_epaper、enrich_regions、column_detect） |
| `README.md` | 产品功能、开发与数据导入说明 |

## 数据纪律（最重要）

- **数据真源唯一**：`cmnrag/` 下的 Markdown 稿件。字段语义以 `cmnrag/FRONTMATTER.md` 为准，不要凭直觉解释：
  - `column` = 报纸编排栏目（如 `科普看台`），不是主题/关键词；
  - `region` = 稿件主体地区（完整路径如 `河北省邢台市沙河市`），不是全文地名清单；
  - `theme` = 版面主题，`edition_type` = 常规版/策划版，两者都不是栏目。
- 结构化问题（计数、列举、筛选）必须走 D1 精确查询，不能只靠向量检索或模型概括；内容性问题先结构化筛选再读正文。
- 字段空值保留为空字符串，不自行补写、猜测或当"全国"处理。
- **栏目识别硬约束**：只能依据本期版面图中实际可见的栏目条填写；看到栏目条且文字属于 `KNOWN_COLS` 时，使用库中的标准栏目名。栏目库只是标准命名白名单，不能证明栏目在本期存在；严禁依据标题/正文主题、位置邻近、历史记录或相似度/子串编造栏目。栏目条识别必须覆盖浅色、小字号、窄条，栏目条证据不足就留空。
- **最终人工审核在所有字段填写完成之后**，是交付后的抽检/修正，不是助手降低识别质量、漏填或编造的理由。
- 修改稿件文件即修改档案，需谨慎；改 `cmnrag/` 数据后若影响线上，需重跑导入/向量脚本。

## Worker 服务（cmnrag-website/）

- Worker 名 `china-meteo-rag`，入口 `src/index.ts`。绑定：D1 `DB`（`zgqxb-archive`）、D1 `PB_DB`（`paiban`，排班表库）、Vectorize `VECTORIZE`（`zgqxb-bge-m3`，1024 维）、Workers AI `AI`、静态资源 `ASSETS`（`public/`，`/api/*`、`/health` 走 Worker）。
- 认证现状（2026-08 起，全站结构浏览需登录）：除 `/health`、`/api/pb/health`、`/api/auth/register`、`/api/auth/login` 外，`/api/*`（含 `/api/articles`、`/api/answer`、`/api/columns`、`/api/themes`）均需登录（未登录返回 401）。排班表 API 挂 `/api/pb/*`（认证统一到主系统，`src/paiban/` 无独立注册/登录）。
- RAG 链路：bge-m3 嵌入 → bge-reranker 重排 → llama-3.1-8b 生成。`ai_unavailable` = 生成管线被捕获的错误；上游嵌入模型可能间歇性返回 500（属上游问题，重试可成功）。
- 改了 `wrangler.jsonc` 绑定后必须跑 `npx wrangler types`。

### 常用命令（cwd = cmnrag-website/）

```bash
npm install
npm test                       # vitest 单元测试
npx wrangler dev --remote      # 直连线上 D1/Vectorize/Workers AI 调试
npx wrangler types             # 绑定变更后重新生成类型
npx tsx scripts/import-archive.ts       # 全文+元数据入 D1（幂等）
npx tsx scripts/ingest-vectors.ts        # 分块+bge-m3 向量入 Vectorize（幂等，默认发现全部月份，CMNRAG_MONTHS 可限定）
```

- 远程调试必须用 `CLOUDFLARE_RAG_API_TOKEN`（带 Workers 权限）；`CLOUDFLARE_API_TOKEN` 缺 Workers 权限，仅 blog-purge 用途。
- **`wrangler deploy` 前需用户确认**，先 `--dry-run` 验证。
- 排班表前端改动：`npm run build:paiban`（构建到 `public/schedule/`）；`src/paiban` 后端改动无需构建，直接 deploy。排班权威数据源在 `cmnrag-website/paiban-data/`（xlsx），改排班规则前先看它。

## 抓取/清洗脚本（scripts/）

- `fetch_epaper.py YYYYMMDD` — 抓取某日稿件（`--guid=XXXXX` 单篇重抓、`--batch` 批量）
- `enrich_regions.py YYYYMMDD` — 地区字段补全（调用 opencode.ai 模型）
- `column_detect.py YYYYMMDD [BC]` — 栏目检测；产物写入被 gitignore 的 `cmnrag/column_test/`
- 数据根目录默认仓库内 `cmnrag/`，可用环境变量 `CMNRAG_DATA_DIR` 覆盖（如 VPS 旧环境）。

## Git 与密钥纪律

- **`.env` 含全部密钥，永不提交**；`.gitignore` 已排除 `.env`、`column_test/`、`node_modules/`、`.wrangler/`、`__pycache__/`。
- `cmnrag-website/` 已随父仓库入库，**不得 `git init`**（防嵌套仓库）。
- 本仓库 git 身份：陆西园 <bladescepter@gmail.com>。

## 已知环境限制与债务

- 本机 `workers.dev` 不可达（TCP 连接超时）→ `wrangler tail` 不可用，线上日志无法通过 tail 获取；`api.cloudflare.com` 可达。
- shell 中 `python3` 是 Store stub，需用 `python`；heredoc 不可用，需写脚本文件。
- 单元测试当前全绿（`npm test`）；`test/julyArchive.spec.ts` 按仓库内 `cmnrag/` 相对路径解析，不依赖 VPS 路径。
- 调试用临时脚手架必须回滚后再提交。

## Cloudflare Workers 通用知识

Worker API 与限额随时可能变化，涉及 Workers/D1/Vectorize/Workers AI 任务时先查官方文档（developers.cloudflare.com）；`cmnrag-website/AGENTS.md` 为 Cloudflare 官方模板，含常用命令与错误速查。
