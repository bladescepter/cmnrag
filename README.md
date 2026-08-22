# cmnrag — 中国气象报稿件资料库

《中国气象报》档案检索系统：**结构化稿件资料库 + 全文检索网站 + 基于 RAG 的 AI 综合问答 + 采访中心排班表**。

已清洗的报纸稿件以 Markdown + YAML frontmatter 形式入库，经 Cloudflare Workers 检索服务对外提供。线上入口：主页 <https://cfzx.xiyuan.wiki>，稿件资料库 <https://cfzx.xiyuan.wiki/db>，排班表 <https://cfzx.xiyuan.wiki/schedule/>。

## 本次更新：排班表并入本仓库（2026-08）

采访中心排班表原本是独立项目（`\DEV\schedule`），现已**整体合并进本仓库**，与资料库共用同一个 Worker（`china-meteo-rag`）和同一套登录认证：

- **后端** `cmnrag-website/src/paiban/`：Hono 子应用，API 挂在 `/api/pb/*`；独立 D1 数据库 `paiban`（绑定 `PB_DB`）；无独立注册/登录，认证统一走主系统
- **前端** `cmnrag-website/paiban-web/`：React + Vite 项目，构建产物输出到 `public/schedule/`，线上路径 `/schedule/`
- **权威数据源** `cmnrag-website/paiban-data/`：采访中心综合值班表 xlsx、见报日历（calendar-2026.json）、数据导入脚本——改排班规则前先看这里
- **旧仓库停用**：请勿再在 `\DEV\schedule` 上做任何修改，一切改动以本仓库为准

## 基本功能

### 资料库（archive）

- **关键词检索**：搜索标题、正文、作者、栏目或地区
- **结构化筛选**（全部可组合）：日期范围、版面（一版～四版）、主题、栏目、主体地区、作者
- 结果分页加载，显示命中总数
- **全文阅读**：展示稿件全文及日期、版面、作者、主题、栏目、地区等完整档案元数据，不消耗 AI 额度
- **AI 综合问答**：在当前筛选范围内重新检索原稿，依据证据生成带引用的回答；只依据档案证据作答，证据不足时明确说明；有每日额度限制

### 排班表（paiban）

- 采访中心一版/二版值班排班：周期轮换生成、格子级锁定、均衡分配
- 值班表查看与导出，历史班表追溯

### 校对（proofread）

- 静态工具页 `/proofread/`，配合资料库使用

## 数据范围与规范

- 当前已入库：**2026 年 6 月至 8 月，共 1337 篇稿件**（202606 计 365 篇 / 202607 计 556 篇 / 202608 计 416 篇）
- 数据真源：仓库内 `cmnrag/YYYYMM/YYYYMMDD/版面/序号-标题.md`，一篇稿件一个文件
- 字段语义（`column` 栏目、`region` 主体地区、`theme` 版面主题等边界）见 [`cmnrag/FRONTMATTER.md`](cmnrag/FRONTMATTER.md)，**这是检索字段的权威定义**
- 结构化问题（计数、筛选、列举）必须走 D1 精确查询，不能只靠向量检索或模型概括

## 仓库结构

```
cmnrag/                 ← 数据真源（按刊期/版面组织的 Markdown 稿件）
  FRONTMATTER.md        ← 检索字段权威定义
cmnrag-website/         ← Cloudflare Workers 服务（三个模块共用一个 Worker）
  src/archive/          ← 资料库检索 API
  src/ai/               ← RAG 问答管线
  src/paiban/           ← 排班表后端（Hono 子应用，挂 /api/pb/*）
  src/ingest/           ← 导入脚本共享逻辑
  paiban-web/           ← 排班表前端源码（React+Vite → public/schedule/）
  paiban-data/          ← 排班权威源（xlsx 综合表格、见报日历、导入脚本）
  public/               ← 静态前端（index 工具集主页、db 资料库、schedule 排班表、proofread 校对）
  scripts/              ← import-archive / ingest-vectors 导入脚本
scripts/                ← 电子报抓取与清洗脚本（fetch_epaper、enrich_regions 等）
README.md               ← 本文件
```

## 本地开发

```bash
cd cmnrag-website
npm install
npm test                    # vitest 单元测试
npx wrangler dev --remote   # 直连线上 D1/Vectorize/Workers AI 调试
```

数据导入（需要 `CLOUDFLARE_RAG_API_TOKEN` 环境变量，两个脚本均幂等）：

```bash
# 全文与元数据入 D1（默认数据根为仓库内 cmnrag/；CMNRAG_MONTHS=202608 可限定月份）
npx tsx scripts/import-archive.ts

# 正文分块 + bge-m3 向量入 Vectorize
npx tsx scripts/ingest-vectors.ts
```

排班表：

```bash
npm run build:paiban    # 构建前端 → public/schedule/
npm run deploy:paiban   # 构建 + 部署（deploy 前需人工确认）
```

后端 `src/paiban/` 改动无需构建，直接部署即可。改了 `wrangler.jsonc` 绑定后必须跑 `npx wrangler types`。

## 技术栈

TypeScript、Cloudflare Workers、D1（SQLite/FTS5）、Vectorize（bge-m3 语义检索）、Workers AI（bge-reranker 重排 + llama-3.1-8b 生成）、Hono、React + Vite、Wrangler、Vitest。
