import { describe, expect, it } from "vitest";
import { chooseEvidenceCount, rerankSources } from "../src/ai/rerank";

describe("rerankSources", () => {
	it("orders candidates by reranker result index and removes duplicate articles", () => {
		const candidates = [
			{ article_id: "a", content: "a first" },
			{ article_id: "a", content: "a duplicate" },
			{ article_id: "b", content: "b" },
			{ article_id: "c", content: "c" },
		];
		const ranked = rerankSources(candidates, [{ index: 2 }, { index: 0 }, { index: 3 }, { index: 1 }]);
		expect(ranked.map((row) => row.article_id)).toEqual(["b", "a", "c"]);
	});

	it("uses fewer evidence articles for a narrow candidate set", () => {
		expect(chooseEvidenceCount(2)).toBe(2);
		expect(chooseEvidenceCount(6)).toBe(6);
		expect(chooseEvidenceCount(12)).toBe(8);
	});
});
