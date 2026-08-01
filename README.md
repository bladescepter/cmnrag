# cmnrag — 中国气象报稿件资料库

《中国气象报》档案检索系统：**结构化稿件资料库 + 全文检索网站 + AI 综合问答**。

已清洗的报纸稿件以 Markdown + YAML frontmatter 形式入库（唯一数据真源），经 Cloudflare Workers 检索服务对外提供，线上入口：<https://cfzx.xiyuan.wiki>

## 基本功能

### 1. 检索与筛选

- **关键词检索**：搜索标题、正文、作者、栏目或地区
- **结构化筛选**（全部可组合）：
  - 日期范围（起始 / 结束日期）
  - 版面：一版 / 二版 / 三版 / 四版
  - 主题（版面主题，如「要闻」「综合」「科普」，输入即出候选）
  - 栏目（报纸编排栏目，输入即出候选，支持连续片段匹配）
  - 主体地区（如「河北」「唐山」「沙河」，支持前缀匹配）
  - 作者（按姓名边界匹配）
- 结果分页加载，显示命中总数

### 2. 全文阅读

点击任意检索结果即可阅读稿件全文，并展示日期、版面、作者、主题、栏目、地区等完整档案元数据。**全文阅读不消耗 AI 额度。**

### 3. AI 综合问答

- 在页内 AI 面板输入问题，系统会**在当前筛选范围内**重新检索原稿，再依据证据生成带引用的回答
- 每条回答附「来源」清单，点击可回看原稿
- 回答纪律：只依据检索到的档案证据作答，证据不足时明确说明；不回答精确计数问题（数量请用上方检索框）
- 有每日 AI 问答额度限制，用尽时前端会明确提示

## 数据范围与规范

- 当前已入库：**2026 年 7 月，528 篇稿件**（一版 143 / 二版 170 / 三版 121 / 四版 94）
- 数据真源：仓库内 `cmnrag/YYYYMM/YYYYMMDD/版面/序号-标题.md`，一篇稿件一个文件
- 字段语义（`column` 栏目、`region` 主体地区、`theme` 版面主题等边界）见 [`cmnrag/FRONTMATTER.md`](cmnrag/FRONTMATTER.md)，**这是检索字段的权威定义**
- 导入：`cmnrag-website/scripts/` 下两个幂等脚本（见下）；数据未入库的新刊期可用其增量导入

## 仓库结构

```
cmnrag/                 ← 数据真源（按刊期/版面组织的 Markdown 稿件）
cmnrag-website/         ← Cloudflare Workers 检索服务（源码 + 测试 + 迁移）
scripts/                ← 电子报抓取与清洗脚本（fetch_epaper、enrich_regions 等）
README.md               ← 本文件
```

## 本地开发

```bash
cd cmnrag-website
npm install
npx wrangler dev --remote   # 本地起服务，直连线上 D1/Vectorize/Workers AI
npm test                    # 单元测试
```

数据导入（需要 `CLOUDFLARE_RAG_API_TOKEN` 环境变量）：

```bash
# 全文与元数据入 D1（默认数据根为仓库内 cmnrag/，可用参数覆盖）
npx tsx scripts/import-archive.ts

# 生成向量入 Vectorize（正文分块 + bge-m3 嵌入）
npx tsx scripts/ingest-july-vectors.ts
```

## 技术栈

TypeScript、Cloudflare Workers、D1（SQLite/FTS5）、Vectorize（bge-m3 语义检索）、Workers AI（bge-reranker 重排 + llama-3.1-8b 生成）、Wrangler、Vitest。
