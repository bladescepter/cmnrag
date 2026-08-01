import { describe, expect, it } from "vitest";
import { buildRagPrompt, uniqueSourcesByArticle, vectorIdForChunk } from "../src/ai/rag";

describe("RAG prompt", () => {
	it("maps a D1 chunk ID to the Vectorize-safe ID used at ingestion", () => {
		expect(vectorIdForChunk("article-1", 2)).toHaveLength(64);
		expect(vectorIdForChunk("article-1", 2)).not.toBe(vectorIdForChunk("article-1", 3));
	});

	it("requires answers to cite only supplied sources and never count", () => {
		const prompt = buildRagPrompt("河北有哪些防汛做法？", [{ id: "a:0", title: "河北防汛", date: "2026-07-29", page: "一版", content: "及时发布预警并转移群众。" }]);
		expect(prompt).toContain("只能依据下列档案证据回答");
		expect(prompt).toContain("绝不能回答");
		expect(prompt).toContain("请使用页面上方的检索框获取精确数量");
		expect(prompt).toContain("[1] 标题：河北防汛");
	});

	it("keeps only the highest-ranked chunk from each article", () => {
		const sources = uniqueSourcesByArticle([
			{ article_id: "a", content: "最相关" }, { article_id: "a", content: "同稿后续块" }, { article_id: "b", content: "另一篇" },
		]);
		expect(sources).toEqual([{ article_id: "a", content: "最相关" }, { article_id: "b", content: "另一篇" }]);
	});

	it("uses history only to resolve follow-up wording, not as evidence", () => {
		const prompt = buildRagPrompt("其中预警怎么做？", [{ id: "a:0", title: "河北防汛", date: "2026-07-29", page: "一版", content: "及时发布预警。" }], [{ role: "user", content: "河北有哪些做法？" }, { role: "assistant", content: "此前回答。" }]);
		expect(prompt).toContain("对话上下文仅用于理解指代");
		expect(prompt).toContain("河北有哪些做法？");
	});
});
