import { describe, expect, it } from "vitest";
import { buildArticleQuery } from "../src/archive/search";

describe("buildArticleQuery", () => {
	it("uses literal substring matching for long column names", () => {
		const name = "“人民至上、生命至上”主题实践活动 发挥气象防灾减灾第一道防线作用";
		const query = buildArticleQuery({ columnName: name });
		expect(query.sql).toContain("instr(column_name, ?) > 0");
		expect(query.params).toEqual([name]);
	});

	it("treats LIKE wildcard characters in metadata as literal text", () => {
		const query = buildArticleQuery({ columnName: "“气象+”赋能_100%" });
		expect(query.params).toEqual(["“气象+”赋能_100%"]);
	});

	it("matches a province and all its subordinate regions", () => {
		const query = buildArticleQuery({ regionPrefix: "河北" });
		expect(query.sql).toContain("instr(region, ?) > 0");
		expect(query.params).toEqual(["河北"]);
	});

	it("matches a city name occurring inside the structured region", () => {
		const query = buildArticleQuery({ regionPrefix: "唐山" });
		expect(query.sql).toContain("instr(region, ?) > 0");
		expect(query.params).toEqual(["唐山"]);
	});

	it("uses indexed fields for a combined archive query", () => {
		const query = buildArticleQuery({ dateFrom: "2026-07-01", dateTo: "2026-07-31", page: ["一版", "二版"], headline: true });
		expect(query.sql).toContain("published_date >= ?");
		expect(query.sql).toContain("published_date <= ?");
		expect(query.sql).toContain("page IN (?, ?)");
		expect(query.sql).toContain("headline = ?");
		expect(query.params).toEqual(["2026-07-01", "2026-07-31", "一版", "二版", 1]);
	});

	it("uses literal partial theme matching", () => {
		const query = buildArticleQuery({ theme: ["庆祝中国共产党"] });
		expect(query.sql).toContain("instr(theme, ?) > 0");
		expect(query.params).toEqual(["庆祝中国共产党"]);
	});

	it("sorts pages by newspaper order rather than Unicode order", () => {
		const query = buildArticleQuery();
		expect(query.sql).toContain("CASE page WHEN '一版' THEN 1 WHEN '二版' THEN 2 WHEN '三版' THEN 3 WHEN '四版' THEN 4 END ASC");
	});
});
