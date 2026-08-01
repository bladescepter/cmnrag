import { describe, expect, it } from "vitest";
import { chunkArticle } from "../src/ingest/chunkArticle";

describe("chunkArticle", () => {
	it("keeps a short article in one complete chunk", () => {
		const chunks = chunkArticle("第一段。\n\n第二段。", 1000);
		expect(chunks).toEqual(["第一段。\n\n第二段。"]);
	});

	it("splits long articles on paragraph boundaries without dropping text", () => {
		const paragraphs = ["甲".repeat(500), "乙".repeat(500), "丙".repeat(500)];
		const chunks = chunkArticle(paragraphs.join("\n\n"), 1000);
		expect(chunks).toEqual(paragraphs);
		expect(chunks.join("\n\n")).toBe(paragraphs.join("\n\n"));
	});

	it("breaks an oversized single paragraph only at sentence boundaries", () => {
		const content = `${"甲".repeat(600)}。${"乙".repeat(600)}。`;
		const chunks = chunkArticle(content, 1000);
		expect(chunks).toEqual([`${"甲".repeat(600)}。`, `${"乙".repeat(600)}。`]);
	});
});
