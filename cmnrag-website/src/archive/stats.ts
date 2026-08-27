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

function parseRegionList(value: string | null | undefined): string[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	} catch {
		// 兼容早期纯字符串/逗号分隔值
	}
	return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function provinceOfRegion(value: string): ProvinceName | undefined {
	const text = value.trim();
	if (!text) return undefined;
	for (const [alias, province] of ALIASES) {
		if (text === alias || text.startsWith(alias)) return province;
	}
	return undefined;
}

export type ProvinceStats = {
	name: ProvinceName;
	short: string;
	count: number;
};

export type StatsResult = {
	total: number;
	with_region: number;
	without_region: number;
	provinces: ProvinceStats[];
	top: ProvinceStats | null;
};

export function aggregateProvinceStats(rows: ProvinceStatRow[]): StatsResult {
	const counts = new Map<ProvinceName, number>(PROVINCES.map((name) => [name, 0]));
	let withRegion = 0;
	for (const row of rows) {
		const regions = parseRegionList(row.region);
		if (regions.length) withRegion++;
		const matched = new Set<ProvinceName>();
		for (const region of regions) {
			const province = provinceOfRegion(region);
			if (province) matched.add(province);
		}
		for (const province of matched) counts.set(province, (counts.get(province) ?? 0) + 1);
	}
	const provinces = PROVINCES.map((name) => ({ name, short: PROVINCE_SHORT[name], count: counts.get(name) ?? 0 }));
	const top = provinces.filter((item) => item.count > 0).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))[0] ?? null;
	return { total: rows.length, with_region: withRegion, without_region: rows.length - withRegion, provinces, top };
}
