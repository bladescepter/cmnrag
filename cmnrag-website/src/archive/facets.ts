const allowedFields = new Set(["column_name", "theme"]);

export type FacetQuery = { sql: string; params: string[] };

// D1 不支持 json_each 表值函数：column_name（JSON 数组字符串）的展开聚合在
// index.ts 的 listFacet 中以 JS 完成；此处 buildFacetQuery 仅服务单值 theme。
export function buildFacetQuery(field: string, partial = ""): FacetQuery {
	if (!allowedFields.has(field)) throw new Error(`Unsupported facet: ${field}`);
	if (!partial) {
		return {
			sql: `SELECT ${field} AS value, COUNT(*) AS count FROM articles WHERE ${field} <> '' GROUP BY ${field} ORDER BY count DESC, value ASC LIMIT 100`,
			params: [],
		};
	}
	return {
		sql: `SELECT ${field} AS value, COUNT(*) AS count FROM articles WHERE ${field} <> '' AND ${field} LIKE ? GROUP BY ${field} ORDER BY CASE WHEN value LIKE ? THEN 0 ELSE 1 END ASC, count DESC, value ASC LIMIT 20`,
		params: [`%${partial}%`, `${partial}%`],
	};
}
