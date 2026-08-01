import { buildFacetQuery } from "./archive/facets";
import { buildArticleQuery } from "./archive/search";
import { parseSearchRequest } from "./archive/request";
import { parsePagination } from "./archive/pagination";
import { buildAnswerArticleIdQuery, buildVectorArticleFilter } from "./ai/answerFilters";
import { buildRagPrompt, uniqueSourcesByArticle, type ConversationTurn, type RagSource } from "./ai/rag";
import { chooseEvidenceCount, rerankSources } from "./ai/rerank";

const EMBEDDING_MODEL = "@cf/baai/bge-m3";
const GENERATION_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});

function error(message: string, status: number) {
	return json({ error: message }, status);
}

async function listFacet(url: URL, env: Env, field: "column_name" | "theme") {
	const query = buildFacetQuery(field, url.searchParams.get("q")?.trim() ?? "");
	const result = await env.DB.prepare(query.sql).bind(...query.params).all<{ value: string; count: number }>();
	return json({ items: result.results });
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
	return json({ items: result.results, total, offset, limit, has_more: offset + result.results.length < total });
}

async function getArticle(id: string, env: Env) {
	const result = await env.DB.prepare("SELECT article_id, source_path, title, subtitle, author, published_date, page, theme, edition_type, headline, image, column_name, region, content FROM articles WHERE article_id = ?").bind(id).first();
	return result ? json(result) : error("not_found", 404);
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
		const embedding = await env.AI.run(EMBEDDING_MODEL, { text: [question] }) as EmbeddingResponse;
		const queryVector = embedding.data?.[0];
		if (!queryVector || queryVector.length !== 1024) throw new Error("embedding_unavailable");
		const vectorFilter = buildVectorArticleFilter(eligibleIds);
		const topK = vectorFilter ? 20 : 50;
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
		const prompt = buildRagPrompt(question, sources.map((source) => ({ id: source.chunk_id, title: source.title, date: source.date, page: source.page, content: source.content })), history);
		const generated = await env.AI.run(GENERATION_MODEL, { messages: [{ role: "user", content: prompt }], max_tokens: 700, temperature: 0.2 }) as { response?: string; choices?: Array<{ message?: { content?: string } }> };
		const answer = generated.response ?? generated.choices?.[0]?.message?.content ?? "现有档案未提供足够依据。";
		return json({ answer, sources: sources.map((source, index) => ({ number: index + 1, article_id: source.article_id, source_path: source.source_path, title: source.title, date: source.date, page: source.page, author: source.author, region: source.region, excerpt: source.content.slice(0, 500) })) });
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
