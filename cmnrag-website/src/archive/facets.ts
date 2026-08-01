const allowedFields = new Set(["column_name", "theme"]);

export type FacetQuery = { sql: string; params: string[] };

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
