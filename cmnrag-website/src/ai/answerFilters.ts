import { buildArticleQuery, type ArticleFilters } from "../archive/search";

export type BuiltArticleIdQuery = { sql: string; params: Array<string | number> };

export function buildVectorArticleFilter(articleIds: string[]) {
	return articleIds.length > 0 && articleIds.length <= 20 ? { articleId: { $in: articleIds } } : undefined;
}

export function buildAnswerArticleIdQuery(filters: ArticleFilters = {}, keyword?: string): BuiltArticleIdQuery {
	const built = buildArticleQuery(filters);
	let sql = built.sql.replace(/SELECT[\s\S]*?FROM articles/, "SELECT article_id FROM articles");
	const params = [...built.params];
	if (keyword) {
		const clause = "(title LIKE ? OR subtitle LIKE ? OR author LIKE ? OR column_name LIKE ? OR region LIKE ? OR content LIKE ?)";
		sql = sql.replace(" ORDER BY", `${built.sql.includes(" WHERE ") ? " AND " : " WHERE "}${clause} ORDER BY`);
		params.push(...Array(6).fill(`%${keyword}%`));
	}
	return { sql, params };
}
