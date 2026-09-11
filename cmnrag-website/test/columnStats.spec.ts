import { describe, expect, it } from "vitest";
import { buildColumnStats } from "../src/archive/columnStats";

describe("column stats", () => {
	it("returns live-style article rows and ranks non-empty columns by count", () => {
		const result = buildColumnStats([
			{ published_date: "2026-09-03", column_name: JSON.stringify(["记者观察", "图片新闻"]) },
			{ published_date: "2026-09-01", column_name: JSON.stringify(["记者观察"]) },
			{ published_date: "2026-09-02", column_name: "短讯速递" },
			{ published_date: "2026-09-04", column_name: "" },
		]);
		expect(result.files).toBe(4);
		expect(result.minDate).toBe("2026-09-01");
		expect(result.maxDate).toBe("2026-09-04");
		expect(result.columns).toEqual(["记者观察", "短讯速递", "图片新闻"]);
		expect(result.counts).toEqual({ "记者观察": 2, "短讯速递": 1, "图片新闻": 1 });
		expect(result.articles).toEqual([
			{ d: "2026-09-01", c: ["记者观察"] },
			{ d: "2026-09-02", c: ["短讯速递"] },
			{ d: "2026-09-03", c: ["记者观察", "图片新闻"] },
			{ d: "2026-09-04", c: [] },
		]);
	});

	it("keeps columns with Chinese lexical ties deterministic", () => {
		const result = buildColumnStats([
			{ published_date: "2026-09-01", column_name: JSON.stringify(["乙栏目"]) },
			{ published_date: "2026-09-01", column_name: JSON.stringify(["甲栏目"]) },
		]);
		expect(result.columns).toEqual(["甲栏目", "乙栏目"]);
	});
});
