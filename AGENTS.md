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
- D1 档案导入脚本使用 `.env` 中的 `CLOUDFLARE_RAG_API_TOKEN`（需具备 D1 权限）。
- 非交互式 Wrangler 部署需要环境变量 `CLOUDFLARE_API_TOKEN`。部署时从 Workers 权限的 RAG token 临时赋值：
  ```bash
  set -a; . ../.env; set +a
  export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_RAG_API_TOKEN"
  ```
  不得使用仅用于 blog-purge 的低权限 token。

## 3. 数据纪律

- `title` 必须由当前 LLM 逐版对照实际版面图或原版 PDF，按版面实情校正完整引题、主标题、副题；接口标题仅作候选，与版面不一致时以版面为准，不得把接口拼接成功当作核对完成。
- 审核汇报按日期、版序逐篇直接列在聊天中，完整展示本地 Markdown 的 `title`、全部 `author`、全部 `region`、全部 `column`；不得省略引题/副题、截字、改写、使用简称、省略号、“等”“同上”或链接代替字段值，篇数多时分段完整列出。
- `column` 是报纸编排栏目，只能依据本期版面图中实际可见的栏目条；`KNOWN_COLS` 只是命名白名单，不能证明栏目在本期存在。
- `region` 按报道主体判定：聚焦一个地区时填写省级开头的完整行政路径；明确聚焦多个合作、联防联控地区时逐项填写 YAML 块式 list，即使跨省也必须填写。全国性、跨区域综述、中国气象局本级事项或主体地区不明确时留空；举例、背景、信息来源中的地名不自动列入。字段语义以 `cmnrag/FRONTMATTER.md` 为准。
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
python scripts/column_detect.py YYYYMMDD
python scripts/column_detect.py YYYYMMDD --check
# 逐版标题核对（版面原图已由 col_vision_run 保存在 column_test/title_evidence/）：
python scripts/fetch_epaper.py --prepare-archive-titles YYYYMMDD
# 当前 LLM 直接读每版实际版面，修正清单内完整 title、稿件对应关系和版面证据，完成后才标记 reviewed：
python scripts/fetch_epaper.py --check-archive-titles YYYYMMDD
python scripts/fetch_epaper.py --apply-archive-titles YYYYMMDD
python scripts/fetch_epaper.py --review-table YYYYMMDD
```

稿件边界按实际版面确定；需要合并时先备份、合并正文，再生成标题核对清单。标题、作者、地区、栏目全部完成且校验通过后，将 `--review-table` 输出逐篇原样贴入聊天，一次性提交人工审核；不得缩略任何字段，不得以文件链接替代审核表。

### 4.2 “入库”的固定含义

用户确认审核后：

- 直接读取本期本地 Markdown 的 `author`、`column` 字段；
- 分别与 `scripts/fetch_epaper.py` 的 `KNOWN_AUTHORS`、`scripts/column_detect.py` 的 `KNOWN_COLS` 取差集；
- 逐人列出新增作者，再写入作者库；确认的新栏目写入栏目库；
- 不重新回查正文、署名或版面图；不把“入库”解释为档案数据上传。

### 4.3 档案数据上线

只要 `cmnrag/` 新增或修改了稿件，必须在 `cmnrag-website/` 中加载根目录 `.env`，按目标日期精确增量导入 D1：

```bash
set -a; . ../.env; set +a
CMNRAG_DATES=YYYYMMDD npx tsx scripts/import-archive.ts
```

`CMNRAG_MONTHS=YYYYMM` 仅用于明确要求的整月批处理；导入脚本要求显式提供 `CMNRAG_DATES` 或 `CMNRAG_MONTHS`，禁止无范围扫描。导入成功后，档案数据已写入线上 D1；不执行向量生成或上传。

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
- 确认 D1 导入成功；
- 确认 `/health` 正常；
- 发现线上与本地差异先汇报，不擅自修复。

## 5. Worker 信息

- Worker 名：`china-meteo-rag`；入口：`cmnrag-website/src/index.ts`。
- 绑定：D1 `DB`（`zgqxb-archive`）、D1 `PB_DB`（`paiban`）、静态资源 `ASSETS`。
- 线上域名：`cfzx.xiyuan.wiki`。
- 修改 `wrangler.jsonc` 绑定后必须执行 `npx wrangler types`。
- 认证例外：`/health`、`/api/pb/health`、`/api/auth/register`、`/api/auth/login`；其余 `/api/*` 默认需要登录。

## 6. Git、环境与故障纪律

- `python3` 是系统 Store stub，使用 `python`；shell 不使用 heredoc。
- 调试临时文件、临时脚手架完成后必须删除或回滚。
- `.env`、`node_modules/`、`.wrangler/`、`__pycache__/`、`cmnrag/column_test/` 不提交。
- 涉及 Cloudflare API、限额或运行时行为时，先查官方文档：<https://developers.cloudflare.com/workers/>。
- 本机 `workers.dev` 不可达，不能依赖 `wrangler tail` 获取线上日志；`api.cloudflare.com` 可达。
