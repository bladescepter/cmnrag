import { buildFacetQuery } from "./archive/facets";
import { buildArticleQuery } from "./archive/search";
import { parseSearchRequest } from "./archive/request";
import { parsePagination } from "./archive/pagination";
import { buildAnswerArticleIdQuery, buildVectorArticleFilter } from "./ai/answerFilters";
import { buildRagSystemPrompt, buildRagUserPrompt, uniqueSourcesByArticle, type ConversationTurn, type RagSource } from "./ai/rag";
import {
	handleAdminAction,
	handleAdminUsers,
	handleLogin,
	handleLogout,
	handleMe,
	handleRegister,
	requireUser,
} from "./auth";
import { chooseEvidenceCount, rerankSources } from "./ai/rerank";
import paibanApp from "./paiban";

const EMBEDDING_MODEL = "@cf/baai/bge-m3";
// 70B fp8 指令遵循与稳定性远优于 8B（实测 8B 会被证据中科普设问句劫持、复读无关内容）；
// 代价是单次生成更贵、消耗每日 AI 额度更快，若额度紧张可改回 @cf/meta/llama-3.1-8b-instruct-fp8-fast
const GENERATION_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

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
		...row,
		author: parseList(row.author),
		column_name: parseList(row.column_name),
		region: parseList(row.region),
	}));
	return json({ items, total, offset, limit, has_more: offset + items.length < total });
}

async function getArticle(id: string, env: Env) {
	const result = await env.DB.prepare("SELECT article_id, source_path, title, subtitle, author, published_date, page, theme, edition_type, headline, image, column_name, region, content FROM articles WHERE article_id = ?").bind(id).first<Record<string, unknown>>();
	if (!result) return error("not_found", 404);
	return json({ ...result, author: parseList(result.author), column_name: parseList(result.column_name), region: parseList(result.region) });
}

type EmbeddingResponse = { data: number[][] };
type AnswerRequest = { question?: unknown; filters?: unknown; history?: unknown };
type SourceRow = RagSource & { chunk_id: string; article_id: string; source_path: string; author: string; region: string; vector_id: string };

async function answerQuestion(request: Request, env: Env) {
	const body = await request.json() as AnswerRequest;
	const question = typeof body.question === "string" ? body.question.trim() : "";
	if (!question || question.length > 1000) return error("question must be 1–1000 characters", 400);
	const filterUrl = new URL("https://filters.local");
	if (body.filters && typeof body.filters === "object" && !Array.isArray(body.filters)) {
		for (const [key, raw] of Object.entries(body.filters as Record<string, unknown>)) {
			if (typeof raw === "string" && raw.trim()) filterUrl.searchParams.set(key, raw.trim());
		}
	}
	const parsedFilters = parseSearchRequest(filterUrl);
	const { keyword, ...metadataFilters } = parsedFilters;
	const history: ConversationTurn[] = Array.isArray(body.history) ? body.history.slice(-8).flatMap((turn): ConversationTurn[] => {
		if (!turn || typeof turn !== "object") return [];
		const candidate = turn as { role?: unknown; content?: unknown };
		return (candidate.role === "user" || candidate.role === "assistant") && typeof candidate.content === "string" && candidate.content.length <= 2000
			? [{ role: candidate.role, content: candidate.content }]
			: [];
	}) : [];
	if (/有[多几]少篇|共[有计]\s*\d|总共|统计|数量|多少[篇条则张章]|几个[版篇章]|[共总]有.*[篇条则]|几篇|几则|几张|几版/.test(question)) return json({ answer: "请使用页面上方的检索框或筛选条件获取精确数量。AI 问答仅依据当前检索到的部分来源做归纳，不能统计全文。" });
	const eligibleQuery = buildAnswerArticleIdQuery(metadataFilters, keyword);
	const eligible = await env.DB.prepare(eligibleQuery.sql).bind(...eligibleQuery.params).all<{ article_id: string }>();
	const eligibleIds = eligible.results.map((row) => row.article_id);
	if (!eligibleIds.length) return json({ answer: "当前筛选条件下没有符合的稿件。", sources: [] });
	try {
		let embedding: EmbeddingResponse;
		try {
			embedding = await env.AI.run(EMBEDDING_MODEL, { text: [question] }) as EmbeddingResponse;
		} catch (first) {
			// 上游嵌入模型偶发 500（属暂时性，重试可成功）；额度类错误不重试直接抛出
			const message = first instanceof Error ? first.message : "";
			if (/quota|neuron|limit|429/i.test(message)) throw first;
			embedding = await env.AI.run(EMBEDDING_MODEL, { text: [question] }) as EmbeddingResponse;
		}
		const queryVector = embedding.data?.[0];
		if (!queryVector || queryVector.length !== 1024) throw new Error("embedding_unavailable");
		const vectorFilter = buildVectorArticleFilter(eligibleIds);
		// 全库无筛选时索引已有数千向量，提高召回避免漏检；带筛选时 20 已足够
		const topK = vectorFilter ? 20 : 100;
		const matches = await env.VECTORIZE.query(queryVector, { topK, returnMetadata: topK > 50 ? "indexed" : "all", ...(vectorFilter ? { filter: vectorFilter } : {}) });
		if (!matches.matches.length) return json({ answer: "现有档案未提供足够依据。", sources: [] });
		const ids = matches.matches.map((match) => match.id);
		const vectorPlaceholders = ids.map(() => "?").join(",");
		const articleFilter = eligibleIds.length < 200 ? ` AND c.article_id IN (${eligibleIds.map(() => "?").join(",")})` : "";
		const args = articleFilter ? [...ids, ...eligibleIds] : ids;
		const rows = await env.DB.prepare(`SELECT c.vector_id, c.chunk_id, c.content, a.article_id, a.source_path, a.title, a.published_date AS date, a.page, a.author, a.region FROM chunks c JOIN articles a ON a.article_id = c.article_id WHERE c.vector_id IN (${vectorPlaceholders})${articleFilter}`).bind(...args).all<SourceRow>();
		const byId = new Map(rows.results.map((row) => [row.vector_id, row]));
		const vectorCandidates = ids.map((id) => byId.get(id)).filter((row): row is SourceRow => Boolean(row));
		const preliminary = uniqueSourcesByArticle(vectorCandidates).slice(0, 20);
		const reranked = await env.AI.run("@cf/baai/bge-reranker-base", { query: question, contexts: preliminary.map((source) => ({ text: source.content })), top_k: Math.min(12, preliminary.length) } as unknown as Ai_Cf_Baai_Bge_Reranker_Base_Input);
		const rerankResults = (reranked.response ?? []).flatMap((item) => typeof item.id === "number" ? [{ index: item.id, score: item.score }] : []);
		const rankedSources = rerankSources(preliminary, rerankResults).slice(0, 12);
		const evidenceCount = chooseEvidenceCount(rankedSources.length);
		const sources = rankedSources.slice(0, evidenceCount);
		if (!sources.length) return json({ answer: "现有档案未提供足够依据。", sources: [] });
		const prompt = buildRagSystemPrompt();
		const userPrompt = buildRagUserPrompt(question, sources.map((source) => ({ id: source.chunk_id, title: source.title, date: source.date, page: source.page, content: source.content })), history);
		const generated = await env.AI.run(GENERATION_MODEL, { messages: [{ role: "system", content: prompt }, { role: "user", content: userPrompt }], max_tokens: 700, temperature: 0.2 }) as { response?: string; choices?: Array<{ message?: { content?: string } }> };
		// 兜底：去掉模型偶尔带出的“根据档案证据…”开场白（内容层面的劫持由 70B + 防劫持提示词解决）
		const answer = (generated.response ?? generated.choices?.[0]?.message?.content ?? "现有档案未提供足够依据。")
			.replace(/^根据档案证据，回答问题[：:]\s*/u, "")
			.replace(/^根据档案证据，\s*/u, "");
		return json({ answer, sources: sources.map((source, index) => ({ number: index + 1, article_id: source.article_id, source_path: source.source_path, title: source.title, date: source.date, page: source.page, author: parseList(source.author), region: parseList(source.region), excerpt: source.content.slice(0, 500) })) });
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : "ai_unavailable";
		if (/quota|neuron|limit|429/i.test(message)) return error("ai_daily_limit", 429);
		console.error(caught);
		return error("ai_unavailable", 503);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (url.pathname === "/health") return json({ status: "ok" });
			// 排班健康检查放行（无需登录）
			if (url.pathname === "/api/pb/health") {
				return paibanApp.fetch(request, env as never);
			}
			// 公开认证接口：注册 / 登录
			if (url.pathname === "/api/auth/register" && request.method === "POST") return handleRegister(request, env);
			if (url.pathname === "/api/auth/login" && request.method === "POST") return handleLogin(request, env);
			// 其余 /api/* 需登录；/api/admin/* 需 admin 角色
			const user = await requireUser(request, env);
			if (url.pathname === "/api/auth/logout" && request.method === "POST") return handleLogout(request, env);
			if (url.pathname === "/api/auth/me") return handleMe(user);
			if (url.pathname === "/api/admin/users" && request.method === "GET") {
				if (!user || user.role !== "admin") return error("forbidden", 403);
				return handleAdminUsers(url, env);
			}
			const adminMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/(approve|reject)$/);
			if (adminMatch && request.method === "POST") {
				if (!user || user.role !== "admin") return error("forbidden", 403);
				return handleAdminAction(request, env, adminMatch[1], adminMatch[2] as "approve" | "reject");
			}
			if (!user) return error("unauthorized", 401);
			// 排班子应用：/api/pb/* 交给 paiban（已通过主登录鉴权）
			if (url.pathname.startsWith("/api/pb/")) {
				return paibanApp.fetch(request, env as never);
			}
			if (url.pathname === "/api/columns") return listFacet(url, env, "column_name");
			if (url.pathname === "/api/themes") return listFacet(url, env, "theme");
			if (url.pathname === "/api/answer" && request.method === "POST") return answerQuestion(request, env);
			if (url.pathname === "/api/articles") return listArticles(url, env);
			if (url.pathname.startsWith("/api/articles/")) return getArticle(decodeURIComponent(url.pathname.slice("/api/articles/".length)), env);
			return error("not_found", 404);
		} catch (caught) {
			console.error(caught);
			return error(caught instanceof Error ? caught.message : "internal_error", 400);
		}
	},
} satisfies ExportedHandler<Env>;
