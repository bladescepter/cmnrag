# AGENTS.md — cmnrag

《中国气象报》稿件资料库：Markdown 数据真源 + Cloudflare Workers 检索服务。线上入口：<https://cfzx.xiyuan.wiki>。

## 1. 范围与数据真源

- 工作目录是仓库根目录 `/home/blade/Projects/cmnrag`。
- `cmnrag/` 下的 `YYYYMM/YYYYMMDD/版面/序号-标题.md` 是唯一数据真源；修改 Markdown 即修改档案。
- `cmnrag/FRONTMATTER.md` 是字段语义权威，修改检索逻辑前必读。
- `cmnrag-website/` 是 Worker 服务；`scripts/` 是抓取、清洗和字段库脚本。
- `cmnrag-website/` 已随父仓库入库，禁止在其中 `git init`。

## 2. 密钥位置与使用

- 密钥文件固定在仓库根目录：`/home/blade/Projects/cmnrag/.env`；不是 `cmnrag-website/.env`。
- `.env` 永不提交、永不打印、永不写入日志。
- D1/Vectorize 导入脚本使用 `.env` 中的 `CLOUDFLARE_RAG_API_TOKEN`（需具备 Workers、D1、Vectorize 权限）。
- 非交互式 Wrangler 部署需要环境变量 `CLOUDFLARE_API_TOKEN`。部署时从 Workers 权限的 RAG token 临时赋值：
  ```bash
  set -a; . ../.env; set +a
  export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_RAG_API_TOKEN"
  ```
  不得使用仅用于 blog-purge 的低权限 token。

## 3. 数据纪律

- `column` 是报纸编排栏目，只能依据本期版面图中实际可见的栏目条；`KNOWN_COLS` 只是命名白名单，不能证明栏目在本期存在。
- `region` 是稿件主体地区，不是全文地名清单；聚焦具体地区时写省级开头的完整行政路径，全国性、跨省或无法唯一归属时留空。
- 空字段保留为空字符串，不猜测、不补写、不把空值当作“全国”。
- 结构化计数、筛选、列举必须走 D1 精确查询；内容性问题先结构化筛选，再读正文。
- 栏目、作者的详细抓取和视觉证据规则见 `.pi/skills/zgqxb-epaper/SKILL.md`。
- 所有字段完成后才进行一次人工审核；审核后的本地 Markdown 是金标准。未经用户明确同意，不得擅自修正审核后的数据。

## 4. 固定新期档案流程

以下顺序固定；用户说“入库”或“上线”时不得自行引入其他含义或无关检查。

### 4.1 抓取与字段完成

使用成熟脚本，不另写临时脚本：

```bash
python scripts/fetch_epaper.py YYYYMMDD
# 填写图片新闻标题后：
python scripts/fetch_epaper.py --apply-titles YYYYMMDD
python scripts/enrich_regions.py YYYYMMDD
# 填写 regions JSON 后：
python scripts/enrich_regions.py --apply YYYYMMDD
python scripts/column_detect.py YYYYMMDD
python scripts/col_vision_run.py YYYYMMDD
# 当前 LLM 写 vision JSON 后：
python scripts/col_vision_run.py --validate YYYYMMDD
python scripts/column_detect.py YYYYMMDD --check
```

抓取、地区、栏目识别全部完成后一次性提交作者/地区/栏目汇总表审核，中途不请示、不播报。

### 4.2 “入库”的固定含义

用户确认审核后：

- 直接读取本期本地 Markdown 的 `author`、`column` 字段；
- 分别与 `scripts/fetch_epaper.py` 的 `KNOWN_AUTHORS`、`scripts/column_detect.py` 的 `KNOWN_COLS` 取差集；
- 逐人列出新增作者，再写入作者库；确认的新栏目写入栏目库；
- 不重新回查正文、署名或版面图；不把“入库”解释为 D1/Vectorize 导入。

### 4.3 档案数据上线

只要 `cmnrag/` 新增或修改了稿件，必须在 `cmnrag-website/` 中加载根目录 `.env`，按目标日期精确增量执行，先 D1 后向量：

```bash
set -a; . ../.env; set +a
CMNRAG_DATES=YYYYMMDD npx tsx scripts/import-archive.ts
CMNRAG_DATES=YYYYMMDD npx tsx scripts/ingest-vectors.ts
```

`CMNRAG_MONTHS=YYYYMM` 仅用于明确要求的整月批处理；两个导入脚本均要求显式提供 `CMNRAG_DATES` 或 `CMNRAG_MONTHS`，禁止无范围扫描。两步均成功后，档案数据才算上线；任一步失败必须停止并报告，不得只部署 Worker 代码。

### 4.4 Worker 部署

用户明确确认上线后：

```bash
set -a; . ../.env; set +a
export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_RAG_API_TOKEN"
npx wrangler deploy --dry-run
npx wrangler deploy
```

新期档案上线不默认执行 `npm test`、`npm install` 或其他无关检查；只有用户要求或本次确实修改了需要验证的 Worker 源码时才执行。

### 4.5 上线核对

- 核对线上 D1 中目标日期篇数与本地稿件数一致；
- 确认向量导入成功；
- 确认 `/health` 正常；
- 发现线上与本地差异先汇报，不擅自修复。

## 5. Worker 信息

- Worker 名：`china-meteo-rag`；入口：`cmnrag-website/src/index.ts`。
- 绑定：D1 `DB`（`zgqxb-archive`）、D1 `PB_DB`（`paiban`）、Vectorize `VECTORIZE`（`zgqxb-bge-m3`）、Workers AI `AI`、静态资源 `ASSETS`。
- 线上域名：`cfzx.xiyuan.wiki`。
- 修改 `wrangler.jsonc` 绑定后必须执行 `npx wrangler types`。
- 认证例外：`/health`、`/api/pb/health`、`/api/auth/register`、`/api/auth/login`；其余 `/api/*` 默认需要登录。

## 6. Git、环境与故障纪律

- `python3` 是系统 Store stub，使用 `python`；shell 不使用 heredoc。
- 调试临时文件、临时脚手架完成后必须删除或回滚。
- `.env`、`node_modules/`、`.wrangler/`、`__pycache__/`、`cmnrag/column_test/` 不提交。
- 涉及 Cloudflare API、限额或运行时行为时，先查官方文档：<https://developers.cloudflare.com/workers/>。
- 本机 `workers.dev` 不可达，不能依赖 `wrangler tail` 获取线上日志；`api.cloudflare.com` 可达。
