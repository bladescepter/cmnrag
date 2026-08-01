import { describe, expect, it } from "vitest";
import { buildVectorArticleFilter } from "../src/ai/answerFilters";

describe("AI answer filters", () => {
	it("uses current structured filters to limit the eligible article IDs", async () => {
		const { buildAnswerArticleIdQuery } = await import("../src/ai/answerFilters");
		const query = buildAnswerArticleIdQuery({ regionPrefix: "河北", columnName: "防灾减灾第一道防线" });
		expect(query.sql).toContain("SELECT article_id FROM articles");
		expect(query.sql).toContain("instr(region, ?) > 0");
		expect(query.sql).toContain("instr(column_name, ?) > 0");
		expect(query.params).toEqual(["防灾减灾第一道防线", "河北"]);
	});

	it("also honors the current keyword field", async () => {
		const { buildAnswerArticleIdQuery } = await import("../src/ai/answerFilters");
		const query = buildAnswerArticleIdQuery({}, "迁西");
		expect(query.sql).toContain("content LIKE ?");
		expect(query.params).toHaveLength(6);
	});

	it("sends a small eligible set to Vectorize as an article-ID filter", () => {
		expect(buildVectorArticleFilter(["a", "b"])).toEqual({ articleId: { $in: ["a", "b"] } });
		expect(buildVectorArticleFilter(Array.from({ length: 25 }, (_, i) => String(i)))).toBeUndefined();
	});
});
