import { describe, expect, it } from "vitest";
import { parseArticle } from "../src/archive/parseArticle";

const source = `---
type: 报道
source: 中国气象报
title: 测试稿件
author: 张三 李四
date: 2026-07-29
page: 二版
theme: 综合
edition_type: 常规版
headline: false
image: true
column: 栏目全称
region: 河北省
---

第一段正文。

第二段正文。`;

describe("parseArticle", () => {
	it("parses frontmatter and preserves the full Chinese body", () => {
		const article = parseArticle(source, "20260729/二版/01-测试稿件.md");
		expect(article.title).toBe("测试稿件");
		expect(article.columnName).toBe("栏目全称");
		expect(article.image).toBe(true);
		expect(article.content).toBe("第一段正文。\n\n第二段正文。");
	});

	it("defaults a missing image flag to false", () => {
		const article = parseArticle(source.replace("image: true\n", ""), "20260729/二版/01-测试稿件.md");
		expect(article.image).toBe(false);
	});

	it("rejects a missing required structured field", () => {
		expect(() => parseArticle(source.replace("page: 二版\n", ""), "bad.md")).toThrow("page");
	});

	it("keeps a metadata-only article when the source has no body", () => {
		const article = parseArticle(source.replace("第一段正文。\n\n第二段正文。", ""), "20260724/四版/04-图片新闻.md");
		expect(article.content).toBe("");
	});
});
