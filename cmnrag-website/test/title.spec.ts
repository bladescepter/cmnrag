import { describe, expect, it } from "vitest";
import { withCompleteTitle } from "../src/archive/title";

describe("archive title output", () => {
	it("returns the full legacy title and preserves article metadata without a subtitle field", () => {
		expect(withCompleteTitle({ article_id: "one", title: "公共气象数据如何安全有序进入“市场”？", subtitle: "——《公共气象数据授权运营管理办法（试行）》解读", author: ["张三"] })).toEqual({
			article_id: "one",
			title: "公共气象数据如何安全有序进入“市场”？ ——《公共气象数据授权运营管理办法（试行）》解读",
			author: ["张三"],
		});
	});

	it("supports articles already stored with a full title and historical null subtitles", () => {
		expect(withCompleteTitle({ title: "完整标题——副题", subtitle: "——副题" })).toEqual({ title: "完整标题——副题" });
		expect(withCompleteTitle({ title: "普通标题", subtitle: null })).toEqual({ title: "普通标题" });
		expect(withCompleteTitle({ title: "完整标题" })).toEqual({ title: "完整标题" });
	});
});
