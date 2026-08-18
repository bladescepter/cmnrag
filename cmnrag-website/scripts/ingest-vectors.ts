import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { chunkArticle } from "../src/ingest/chunkArticle";
import { buildEmbeddingText, discoverMonthFiles } from "../src/ingest/julyArchive";
import { vectorIdForChunk } from "../src/ingest/vectorId";
import { parseArticle } from "../src/archive/parseArticle";

// 默认指向仓库内数据根目录（<项目根>/cmnrag），可用第一个参数覆盖；
// 以脚本位置为锚，不依赖运行时 cwd。
const sourceRoot = process.argv[2] ?? join(__dirname, "..", "..", "cmnrag");
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "6af7ecfe8e736f150bae5089463f9293";
const token = process.env.CLOUDFLARE_RAG_API_TOKEN;
const databaseId = "f0fbe6ce-5e87-4885-9ab6-7e948ec13c4d";
const indexName = "zgqxb-bge-m3";
const EMBEDDING_MODEL = "@cf/baai/bge-m3";
const BATCH_SIZE = 20;
if (!token) throw new Error("CLOUDFLARE_RAG_API_TOKEN is required");

type ArticleRow = ReturnType<typeof parseArticle>;
type ChunkRow = {
	vectorId: string;
	chunkId: string;
	articleId: string;
	chunkIndex: number;
	chunkTotal: number;
	content: string;
	contentSha256: string;
	embeddingText: string;
	article: ArticleRow;
};

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function cloudflare(path: string, init: RequestInit) {
	const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
		...init,
		headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
	});
	if (!response.ok) throw new Error(`Cloudflare ${response.status} ${path}: ${await response.text()}`);
	const data = await response.json() as { success: boolean; errors?: unknown[]; result?: unknown };
	if (!data.success) throw new Error(`Cloudflare failed ${path}: ${JSON.stringify(data.errors)}`);
	return data;
}

async function execute(sql: string, params: unknown[]) {
	await cloudflare(`/d1/database/${databaseId}/query`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sql, params }),
	});
}

async function query(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
	const data = await cloudflare(`/d1/database/${databaseId}/query`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sql, params }),
	});
	return (data.result as Array<{ results: Array<Record<string, unknown>> }> | undefined)?.[0]?.results ?? [];
}

async function embed(texts: string[]): Promise<number[][]> {
	const data = await cloudflare(`/ai/run/${EMBEDDING_MODEL}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: texts }),
	});
	const result = data.result as { data?: number[][]; shape?: number[] } | number[][];
	const vectors = Array.isArray(result) ? result : result.data;
	if (!vectors || vectors.length !== texts.length || vectors.some((vector) => vector.length !== 1024)) {
		throw new Error(`Unexpected embedding response for ${texts.length} texts`);
	}
	return vectors;
}

async function upsertVectors(rows: ChunkRow[], vectors: number[][]) {
	const ndjson = rows.map((row, index) => JSON.stringify({
		id: row.vectorId,
		values: vectors[index],
		metadata: {
			articleId: row.articleId,
			publishedDate: row.article.date,
			page: row.article.page,
			theme: row.article.theme,
			editionType: row.article.editionType,
			headline: row.article.headline,
			image: row.article.image,
		},
	})).join("\n");
	const form = new FormData();
	form.set("vectors", new Blob([ndjson], { type: "application/x-ndjson" }), "vectors.ndjson");
	await cloudflare(`/vectorize/v2/indexes/${indexName}/upsert`, { method: "POST", body: form });
}

async function upsertArticle(article: ArticleRow) {
	await execute(`INSERT INTO articles(article_id, source_path, source_sha256, type, source, title, subtitle, author, published_date, page, theme, edition_type, headline, image, column_name, region, content)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(source_path) DO UPDATE SET article_id=excluded.article_id, source_sha256=excluded.source_sha256, type=excluded.type, source=excluded.source, title=excluded.title, subtitle=excluded.subtitle, author=excluded.author, published_date=excluded.published_date, page=excluded.page, theme=excluded.theme, edition_type=excluded.edition_type, headline=excluded.headline, image=excluded.image, column_name=excluded.column_name, region=excluded.region, content=excluded.content, imported_at=CURRENT_TIMESTAMP`, [article.articleId, article.sourcePath, article.sourceSha256, article.type, article.source, article.title, article.subtitle, JSON.stringify(article.author), article.date, article.page, article.theme, article.editionType, article.headline ? 1 : 0, article.image ? 1 : 0, JSON.stringify(article.columnName), JSON.stringify(article.region), article.content]);
}

async function main() {
	// 月份列表：CMNRAG_MONTHS=202607,202608 或默认 7、8 月
	const months = (process.env.CMNRAG_MONTHS ?? "202607,202608").split(",").map((s) => s.trim()).filter(Boolean);
	const files = await discoverMonthFiles(sourceRoot, months);
	const articles = await Promise.all(files.map(async (file) => parseArticle(await readFile(file, "utf8"), relative(sourceRoot, file).split(sep).join("/"))));
	const runId = randomUUID();
	await execute("INSERT INTO ingest_runs(run_id, started_at, source_root, article_total) VALUES (?, datetime('now'), ?, ?)", [runId, `${sourceRoot}/${months.join(",")}`, articles.length]);
	// 增量：以 chunks 表嵌入时的 source_sha256 为判据（不能用 articles 表——import 脚本会
	// 先把它更新为新值，导致内容变了向量却永不重刷）。本地 sha 与已嵌入 sha 不一致或
	// 无嵌入记录的文章整体重刷其分块。
	const existing = new Map(
		(await query("SELECT article_id, source_sha256 FROM chunks", [])).map((row) => [String(row.article_id), String(row.source_sha256)]),
	);
	const toRefresh = articles.filter((article) => article.content.length > 0 && existing.get(article.articleId) !== article.sourceSha256);
	const skipped = articles.length - toRefresh.length;
	const chunks = toRefresh.flatMap((article) => chunkArticle(article.content).map((content, chunkIndex, all) => ({
		vectorId: vectorIdForChunk(article.articleId, chunkIndex),
		chunkId: `${article.articleId}:${chunkIndex}`,
		articleId: article.articleId,
		chunkIndex,
		chunkTotal: all.length,
		content,
		contentSha256: sha256(content),
		embeddingText: buildEmbeddingText(article, content),
		article,
	}))).filter((chunk) => chunk.content.length > 0);
	for (const article of toRefresh) await upsertArticle(article);
	for (let offset = 0; offset < chunks.length; offset += BATCH_SIZE) {
		const batch = chunks.slice(offset, offset + BATCH_SIZE);
		const vectors = await embed(batch.map((chunk) => chunk.embeddingText));
		await upsertVectors(batch, vectors);
		for (const chunk of batch) {
			await execute(`INSERT INTO chunks(chunk_id, vector_id, article_id, chunk_index, chunk_total, content, content_sha256, embedding_model, source_sha256)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(chunk_id) DO UPDATE SET vector_id=excluded.vector_id, article_id=excluded.article_id, chunk_index=excluded.chunk_index, chunk_total=excluded.chunk_total, content=excluded.content, content_sha256=excluded.content_sha256, embedding_model=excluded.embedding_model, source_sha256=excluded.source_sha256`, [chunk.chunkId, chunk.vectorId, chunk.articleId, chunk.chunkIndex, chunk.chunkTotal, chunk.content, chunk.contentSha256, EMBEDDING_MODEL, chunk.article.sourceSha256]);
		}
		console.log(`embedded ${Math.min(offset + batch.length, chunks.length)}/${chunks.length}`);
	}
	await execute("UPDATE ingest_runs SET completed_at=datetime('now'), inserted_count=?, failed_count=0 WHERE run_id=?", [toRefresh.length, runId]);
	console.log(JSON.stringify({ runId, articles: toRefresh.length, skipped, chunks: chunks.length, sourceRoot: `${sourceRoot}/${months.join(",")}` }));
}

main().catch(async (error) => {
	console.error(error instanceof Error ? error.stack : error);
	process.exit(1);
});
