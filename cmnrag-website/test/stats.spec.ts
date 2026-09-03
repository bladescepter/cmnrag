import { describe, expect, it } from "vitest";
import { aggregateDays, provinceOfRegion, parseRegionList } from "../src/archive/stats";

describe("province stats", () => {
	it("maps full region paths to provinces and dedupes cross-province regions per article", () => {
		const result = aggregateDays([
			{ published_date: "2026-09-03", region: JSON.stringify(["河北省邢台市沙河市"]) },
			{ published_date: "2026-09-03", region: JSON.stringify(["河北省石家庄市", "山西省太原市"]) },
			{ published_date: "2026-09-03", region: JSON.stringify(["河北省邢台市", "河北省沙河市"]) },
		]);
		expect(result.articleFiles).toBe(3);
		expect(result.dates).toHaveLength(1);
		const day = result.dates[0];
		expect(day.date).toBe("2026-09-03");
		expect(day.total).toBe(3);
		expect(day.unassigned).toBe(0);
		// 跨省各计一次；同省多地区去重计一次
		expect(day.counts["河北"]).toBe(3);
		expect(day.counts["山西"]).toBe(1);
	});

	it("counts empty-region articles as unassigned", () => {
		const result = aggregateDays([
			{ published_date: "2026-08-31", region: null },
			{ published_date: "2026-08-31", region: JSON.stringify([]) },
			{ published_date: "2026-08-31", region: JSON.stringify(["四川省成都市"]) },
		]);
		const day = result.dates[0];
		expect(day.total).toBe(3);
		expect(day.unassigned).toBe(2);
		expect(day.counts["四川"]).toBe(1);
	});

	it("sorts days ascending and reports available span", () => {
		const result = aggregateDays([
			{ published_date: "2026-09-03", region: JSON.stringify(["北京市"]) },
			{ published_date: "2026-06-01", region: JSON.stringify(["上海市"]) },
			{ published_date: "2026-07-15", region: JSON.stringify(["天津市"]) },
		]);
		expect(result.availableMin).toBe("2026-06-01");
		expect(result.availableMax).toBe("2026-09-03");
		expect(result.dates.map((d) => d.date)).toEqual(["2026-06-01", "2026-07-15", "2026-09-03"]);
	});

	it("maps autonomous regions and legacy city-only regions", () => {
		expect(provinceOfRegion("内蒙古自治区鄂尔多斯市乌审旗")).toBe("内蒙古自治区");
		expect(provinceOfRegion("广西壮族自治区南宁市")).toBe("广西壮族自治区");
		expect(provinceOfRegion("黄山市")).toBe("安徽省");
		expect(provinceOfRegion("中国气象局")).toBeUndefined();
	});

	it("parses legacy comma-separated region strings", () => {
		expect(parseRegionList("河北省, 山西省")).toEqual(["河北省", "山西省"]);
		expect(parseRegionList("")).toEqual([]);
		expect(parseRegionList(null)).toEqual([]);
	});
});
