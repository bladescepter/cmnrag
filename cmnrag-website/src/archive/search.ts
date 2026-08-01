export type ArticleFilters = {
	columnName?: string;
	regionPrefix?: string;
	dateFrom?: string;
	dateTo?: string;
	page?: string[];
	theme?: string[];
	author?: string;
	headline?: boolean;
	image?: boolean;
};

export type BuiltQuery = { sql: string; params: Array<string | number> };

export function buildArticleQuery(filters: ArticleFilters = {}): BuiltQuery {
	const where: string[] = [];
	const params: Array<string | number> = [];

	// SQLite's LIKE implementation can reject long Unicode patterns in D1.
	// instr() treats the user input as literal text and preserves partial matching.
	if (filters.columnName) {
		where.push("instr(column_name, ?) > 0");
		params.push(filters.columnName);
	}
	if (filters.regionPrefix) {
		where.push("instr(region, ?) > 0");
		params.push(filters.regionPrefix);
	}
	if (filters.dateFrom) {
		where.push("published_date >= ?");
		params.push(filters.dateFrom);
	}
	if (filters.dateTo) {
		where.push("published_date <= ?");
		params.push(filters.dateTo);
	}
	if (filters.page?.length) {
		where.push(`page IN (${filters.page.map(() => "?").join(", ")})`);
		params.push(...filters.page);
	}
	if (filters.theme?.length) {
		where.push(filters.theme.map(() => "instr(theme, ?) > 0").join(" AND "));
		params.push(...filters.theme);
	}
	if (filters.author) {
		where.push("instr(author, ?) > 0");
		params.push(filters.author);
	}
	if (filters.headline !== undefined) {
		where.push("headline = ?");
		params.push(filters.headline ? 1 : 0);
	}
	if (filters.image !== undefined) {
		where.push("image = ?");
		params.push(filters.image ? 1 : 0);
	}

	return {
		sql: `SELECT article_id, source_path, title, subtitle, author, published_date, page, theme, edition_type, headline, image, column_name, region FROM articles${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY published_date DESC, CASE page WHEN '一版' THEN 1 WHEN '二版' THEN 2 WHEN '三版' THEN 3 WHEN '四版' THEN 4 END ASC, source_path ASC`,
		params,
	};
}
