export type ColumnStatsRow = {
	published_date: string;
	column_name: string | null;
};

export type ColumnStatsArticle = {
	d: string;
	c: string[];
};

export type ColumnStatsPayload = {
	files: number;
	minDate: string;
	maxDate: string;
	columns: string[];
	counts: Record<string, number>;
	articles: ColumnStatsArticle[];
};

function parseColumnList(value: unknown): string[] {
	if (typeof value !== "string" || !value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "");
	} catch {
		/* fall through: historical plain strings are kept as one value */
	}
	return [value];
}

export function buildColumnStats(rows: ColumnStatsRow[]): ColumnStatsPayload {
	const articles = rows
		.map((row) => ({ d: row.published_date, c: parseColumnList(row.column_name) }))
		.sort((a, b) => a.d.localeCompare(b.d));
	const counts = new Map<string, number>();
	for (const article of articles) {
		for (const column of article.c) counts.set(column, (counts.get(column) ?? 0) + 1);
	}
	const columns = [...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b, "zh-CN"));
	const dates = articles.map((article) => article.d).filter(Boolean);
	return {
		files: articles.length,
		minDate: dates[0] ?? "",
		maxDate: dates[dates.length - 1] ?? "",
		columns,
		counts: Object.fromEntries(columns.map((column) => [column, counts.get(column) ?? 0])),
		articles,
	};
}
