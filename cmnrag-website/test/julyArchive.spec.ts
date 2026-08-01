import { describe, expect, it } from "vitest";
import { buildEmbeddingText, discoverJulyFiles } from "../src/ingest/julyArchive";

describe("July archive ingestion", () => {
	it("adds structured metadata before chunk text for embedding", () => {
		const text = buildEmbeddingText({ title: "防汛报道", author: "张三", date: "2026-07-01", page: "一版", theme: "要闻", columnName: "短讯速递", region: "河北省" }, "正文内容");
		expect(text).toContain("标题：防汛报道");
		expect(text).toContain("栏目：短讯速递");
		expect(text.endsWith("正文：正文内容")).toBe(true);
	});

	it("limits discovery to the 202607 directory", async () => {
		const paths = await discoverJulyFiles("/opt/data/cmnrag");
		expect(paths.length).toBeGreaterThan(500);
		expect(paths.every((path: string) => path.includes("/202607/"))).toBe(true);
	});
});
