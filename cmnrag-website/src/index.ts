import { buildFacetQuery } from "./archive/facets";
import { buildArticleQuery } from "./archive/search";
import { withCompleteTitle } from "./archive/title";
import { parseSearchRequest } from "./archive/request";
import { parsePagination } from "./archive/pagination";
import { aggregateDays, type ProvinceStatRow } from "./archive/stats";
import { buildColumnStats, type ColumnStatsRow } from "./archive/columnStats";
import {
	handleAdminAction,
	handleAdminProofreadingAccess,
	handleAdminUsers,
	handleLogin,
	handleLogout,
	handleMe,
	handleRegister,
	requireUser,
} from "./auth";
import paibanApp from "./paiban";
import { handleProofreading } from "./proofreading/gateway";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});

/** D1 存的 author/column_name/region 是 JSON 数组字符串，输出时解析为数组；兼容历史纯字符串 */
function parseList(value: unknown): string[] {
	if (typeof value !== "string" || !value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
	} catch {
		/* fallthrough: 历史分隔符字符串 */
	}
	return [value];
}

function error(message: string, status: number) {
	return json({ error: message }, status);
}

async function listFacet(url: URL, env: Env, field: "column_name" | "theme") {
	const partial = url.searchParams.get("q")?.trim() ?? "";
	if (field === "theme") {
		const query = buildFacetQuery(field, partial);
		const result = await env.DB.prepare(query.sql).bind(...query.params).all<{ value: string; count: number }>();
		return json({ items: result.results });
	}
	// column_name 存 JSON 数组字符串且 D1 无 json_each：全量拉回后在 JS 层展开聚合
	const sql = partial
		? "SELECT column_name FROM articles WHERE column_name <> '' AND instr(column_name, ?) > 0"
		: "SELECT column_name FROM articles WHERE column_name <> ''";
	const result = await env.DB.prepare(sql).bind(...(partial ? [partial] : [])).all<{ column_name: string }>();
	const counts = new Map<string, number>();
	for (const row of result.results) {
		for (const item of parseList(row.column_name)) {
			counts.set(item, (counts.get(item) ?? 0) + 1);
		}
	}
	const items = [...counts.entries()]
		.map(([value, count]) => ({ value, count }))
		.sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
		.slice(0, partial ? 20 : 100);
	return json({ items });
}

async function listArticles(url: URL, env: Env) {
	const request = parseSearchRequest(url);
	const { keyword, ...filters } = request;
	const built = buildArticleQuery(filters);
	let sql = built.sql;
	const params = [...built.params];
	if (keyword) {
		const where = "(title LIKE ? OR subtitle LIKE ? OR author LIKE ? OR column_name LIKE ? OR region LIKE ? OR content LIKE ?)";
		const values = Array(6).fill(`%${keyword}%`);
		sql = sql.replace(" ORDER BY", `${built.sql.includes(" WHERE ") ? " AND " : " WHERE "}${where} ORDER BY`);
		params.push(...values);
	}
	const { limit, offset } = parsePagination(url);
	const countSql = sql.replace(/SELECT[\s\S]*?FROM articles/, "SELECT COUNT(*) AS total FROM articles").replace(/ ORDER BY[\s\S]*$/, "");
	const [result, countResult] = await Promise.all([
		env.DB.prepare(`${sql} LIMIT ? OFFSET ?`).bind(...params, limit, offset).all(),
		env.DB.prepare(countSql).bind(...params).first<{ total: number }>(),
	]);
	const total = countResult?.total ?? 0;
	const items = (result.results as Array<Record<string, unknown>>).map((row) => ({
		...withCompleteTitle({ ...row, title: row.title }),
		author: parseList(row.author),
		column_name: parseList(row.column_name),
		region: parseList(row.region),
	}));
	return json({ items, total, offset, limit, has_more: offset + items.length < total });
}

async function getArticle(id: string, env: Env) {
	const result = await env.DB.prepare("SELECT article_id, source_path, title, subtitle, author, published_date, page, theme, edition_type, headline, image, column_name, region, content FROM articles WHERE article_id = ?").bind(id).first<Record<string, unknown>>();
	if (!result) return error("not_found", 404);
	return json({ ...withCompleteTitle({ ...result, title: result.title }), author: parseList(result.author), column_name: parseList(result.column_name), region: parseList(result.region) });
}

async function listProvinceStats(env: Env) {
	const result = await env.DB.prepare("SELECT published_date, region FROM articles").all<ProvinceStatRow>();
	return json(aggregateDays(result.results));
}

async function listColumnStats(env: Env) {
	const result = await env.DB.prepare("SELECT published_date, column_name FROM articles ORDER BY published_date ASC, article_id ASC").all<ColumnStatsRow>();
	return json(buildColumnStats(result.results));
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		try {
			// 工作台规范地址为 /proofreading/；旧的 /proofread/ 仅作兼容跳转。
			if (request.method === "GET" && ["/proofread", "/proofread/", "/proofread/index.html"].includes(url.pathname)) {
				return Response.redirect(new URL(`/proofreading/${url.search}`, url.origin).toString(), 308);
			}
			if (url.pathname === "/health") return json({ status: "ok" });
			// 排班健康检查放行（无需登录）
			if (url.pathname === "/api/pb/health") {
				return paibanApp.fetch(request, env as never);
			}
			// 公开认证接口：注册 / 登录
			if (url.pathname === "/api/auth/register" && request.method === "POST") return handleRegister(request, env);
			if (url.pathname === "/api/auth/login" && request.method === "POST") return handleLogin(request, env);
			// 认证状态与管理员接口仍需会话；资料库接口公开，只有排班接口保留登录门禁。
			if (url.pathname === "/api/auth/logout" && request.method === "POST") return handleLogout(request, env);
			if (url.pathname === "/api/auth/me") return handleMe(await requireUser(request, env));
			if (url.pathname === "/api/admin/users" && request.method === "GET") {
				const user = await requireUser(request, env);
				if (!user || user.role !== "admin") return error("forbidden", 403);
				return handleAdminUsers(url, env);
			}
			const adminMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/(approve|reject)$/);
			if (adminMatch && request.method === "POST") {
				const user = await requireUser(request, env);
				if (!user || user.role !== "admin") return error("forbidden", 403);
				return handleAdminAction(request, env, adminMatch[1], adminMatch[2] as "approve" | "reject");
			}
			const proofreadingAccessMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/proofreading$/);
			if (proofreadingAccessMatch && request.method === "POST") {
				const user = await requireUser(request, env);
				if (!user || user.status !== "approved" || user.role !== "admin") return error("forbidden", 403);
				return handleAdminProofreadingAccess(request, env, proofreadingAccessMatch[1]);
			}
			// 校对服务所有路径先做身份、账号状态和请求边界校验；不进入档案接口。
			if (url.pathname === "/api/proofreading" || url.pathname.startsWith("/api/proofreading/")) {
				return handleProofreading(request, env, await requireUser(request, env));
			}
			// 排班子应用：/api/pb/* 交给 paiban，并保留主系统登录鉴权。
			if (url.pathname.startsWith("/api/pb/")) {
				const user = await requireUser(request, env);
				if (!user) return error("unauthorized", 401);
				return paibanApp.fetch(request, env as never);
			}
			// 资料库与统计接口公开访问；页面本身也不再强制跳转登录。
			if (url.pathname === "/api/columns") return listFacet(url, env, "column_name");
			if (url.pathname === "/api/themes") return listFacet(url, env, "theme");
			if (url.pathname === "/api/articles") return listArticles(url, env);
			if (url.pathname.startsWith("/api/articles/")) return getArticle(decodeURIComponent(url.pathname.slice("/api/articles/".length)), env);
			if (url.pathname === "/api/stats") return listProvinceStats(env);
			if (url.pathname === "/api/column-stats") return listColumnStats(env);
			return error("not_found", 404);
		} catch (caught) {
			console.error(caught);
			return error(caught instanceof Error ? caught.message : "internal_error", 400);
		}
	},
} satisfies ExportedHandler<Env>;
