export type ProvinceStatRow = { published_date: string; region: string | null };

export const PROVINCES = [
	"北京市", "天津市", "上海市", "重庆市", "河北省", "山西省", "辽宁省", "吉林省", "黑龙江省",
	"江苏省", "浙江省", "安徽省", "福建省", "江西省", "山东省", "河南省", "湖北省", "湖南省",
	"广东省", "海南省", "四川省", "贵州省", "云南省", "陕西省", "甘肃省", "青海省", "台湾省",
	"内蒙古自治区", "广西壮族自治区", "西藏自治区", "宁夏回族自治区", "新疆维吾尔自治区",
	"香港特别行政区", "澳门特别行政区",
] as const;

export type ProvinceName = (typeof PROVINCES)[number];

export const PROVINCE_SHORT: Record<ProvinceName, string> = {
	北京市: "北京", 天津市: "天津", 上海市: "上海", 重庆市: "重庆", 河北省: "河北", 山西省: "山西",
	辽宁省: "辽宁", 吉林省: "吉林", 黑龙江省: "黑龙江", 江苏省: "江苏", 浙江省: "浙江", 安徽省: "安徽",
	福建省: "福建", 江西省: "江西", 山东省: "山东", 河南省: "河南", 湖北省: "湖北", 湖南省: "湖南",
	广东省: "广东", 海南省: "海南", 四川省: "四川", 贵州省: "贵州", 云南省: "云南", 陕西省: "陕西",
	甘肃省: "甘肃", 青海省: "青海", 台湾省: "台湾", 内蒙古自治区: "内蒙古", 广西壮族自治区: "广西",
	西藏自治区: "西藏", 宁夏回族自治区: "宁夏", 新疆维吾尔自治区: "新疆", 香港特别行政区: "香港",
	澳门特别行政区: "澳门",
};

const ALIASES: Array<[string, ProvinceName]> = [
	["内蒙古", "内蒙古自治区"], ["广西", "广西壮族自治区"], ["西藏", "西藏自治区"],
	["宁夏", "宁夏回族自治区"], ["新疆", "新疆维吾尔自治区"], ["香港", "香港特别行政区"],
	["澳门", "澳门特别行政区"], ["北京", "北京市"], ["天津", "天津市"], ["上海", "上海市"],
	["重庆", "重庆市"], ["河北", "河北省"], ["山西", "山西省"], ["辽宁", "辽宁省"], ["吉林", "吉林省"],
	["黑龙江", "黑龙江省"], ["江苏", "江苏省"], ["浙江", "浙江省"], ["安徽", "安徽省"], ["福建", "福建省"],
	["江西", "江西省"], ["山东", "山东省"], ["河南", "河南省"], ["湖北", "湖北省"], ["湖南", "湖南省"],
	["广东", "广东省"], ["海南", "海南省"], ["四川", "四川省"], ["贵州", "贵州省"], ["云南", "云南省"],
	["陕西", "陕西省"], ["甘肃", "甘肃省"], ["青海", "青海省"], ["台湾", "台湾省"],
	// 历史档案中曾出现未带省名的地级市，按主体地区归属处理。
	["黄山市", "安徽省"],
];

/** 解析 D1 中 region 列：JSON 数组字符串；兼容历史纯字符串/逗号分隔值 */
export function parseRegionList(value: string | null | undefined): string[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	} catch {
		/* 兼容早期纯字符串/逗号分隔值 */
	}
	return value.split(",").map((item) => item.trim()).filter(Boolean);
}

/** 完整行政路径（省+市+县）→ 省级区全名；未命中返回 undefined */
export function provinceOfRegion(value: string): ProvinceName | undefined {
	const text = value.trim();
	if (!text) return undefined;
	for (const [alias, province] of ALIASES) {
		if (text === alias || text.startsWith(alias)) return province;
	}
	return undefined;
}

export type DayStat = {
	date: string;
	total: number;
	unassigned: number;
	/** 省级区短名 → 篇数；一篇稿件地区跨多个省级区则在对应省各计一次 */
	counts: Record<string, number>;
};

export type ProvinceStatsResult = {
	availableMin: string;
	availableMax: string;
	/** 档案总文件数（全部日期，含无地区稿件） */
	articleFiles: number;
	dates: DayStat[];
};

/**
 * 按出版日聚合：每天统计稿件总数、无地区稿件数、各省级区短名计数。
 * 行按日期升序输出，供前端按日期区间筛选聚合。
 */
export function aggregateDays(rows: ProvinceStatRow[]): ProvinceStatsResult {
	const byDate = new Map<string, DayStat>();
	for (const row of rows) {
		if (!row.published_date) continue;
		let day = byDate.get(row.published_date);
		if (!day) {
			day = { date: row.published_date, total: 0, unassigned: 0, counts: {} };
			byDate.set(row.published_date, day);
		}
		day.total++;
		const regions = parseRegionList(row.region);
		if (regions.length === 0) {
			day.unassigned++;
			continue;
		}
		const matched = new Set<ProvinceName>();
		for (const region of regions) {
			const province = provinceOfRegion(region);
			if (province) matched.add(province);
		}
		for (const province of matched) {
			day.counts[PROVINCE_SHORT[province]] = (day.counts[PROVINCE_SHORT[province]] ?? 0) + 1;
		}
	}
	const dates = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
	const first = dates[0]?.date ?? "";
	const last = dates[dates.length - 1]?.date ?? "";
	return { availableMin: first, availableMax: last, articleFiles: rows.length, dates };
}
