import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parseArticle } from "../src/archive/parseArticle";

// 默认指向仓库内数据根目录（<项目根>/cmnrag），可用第一个参数覆盖；
// 以脚本位置为锚，不依赖运行时 cwd。
const sourceRoot = process.argv[2] ?? join(__dirname, "..", "..", "cmnrag");
// 月份过滤：CMNRAG_MONTHS=202606,202607 时只导这些月份；留空则全量发现 YYYYMM 目录。
// 6 月资料已完成审核，和其他月份一样属于正式数据，不再作为测试月份排除。
const monthSet = new Set((process.env.CMNRAG_MONTHS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "6af7ecfe8e736f150bae5089463f9293";
const token = process.env.CLOUDFLARE_RAG_API_TOKEN;
const databaseId = "f0fbe6ce-5e87-4885-9ab6-7e948ec13c4d";
const vectorIndex = process.env.VECTORIZE_INDEX ?? "zgqxb-bge-m3";
const SQL_BATCH_SIZE = 50;
const VECTOR_BATCH_SIZE = 1000;
if (!token) throw new Error("CLOUDFLARE_RAG_API_TOKEN is required");

async function discoverMonths(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isDirectory() && /^\d{6}$/.test(entry.name))
		.map((entry) => entry.name)
		.sort();
}

async function walk(directory: string, selectedMonths: Set<string>, depth = 0): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(entries.map((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			// 只遍历数据根下选中的 YYYYMM 目录，避免把临时目录当成档案来源。
			if (depth === 0 && (!/^\d{6}$/.test(entry.name) || !selectedMonths.has(entry.name))) return [];
			return walk(path, selectedMonths, depth + 1);
		}
		return entry.name.endsWith(".md") && /^2026\d{4}$/.test(directory.split(/[\\/]/).at(-2) ?? "") ? [path] : [];
	}));
	return nested.flat();
}

async function execute(sql: string, params: unknown[]) {
	const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ sql, params }),
	});
	if (!response.ok) throw new Error(`D1 HTTP ${response.status}: ${await response.text()}`);
	const data = await response.json() as { success: boolean; errors?: unknown[] };
	if (!data.success) throw new Error(`D1 failed: ${JSON.stringify(data.errors)}`);
}

async function query(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
	const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ sql, params }),
	});
	if (!response.ok) throw new Error(`D1 HTTP ${response.status}: ${await response.text()}`);
	const data = await response.json() as { success: boolean; result?: Array<{ results: Array<Record<string, unknown>> }>; errors?: unknown[] };
	if (!data.success) throw new Error(`D1 failed: ${JSON.stringify(data.errors)}`);
	return data.result?.[0]?.results ?? [];
}

type ExistingArticle = {
	sourcePath: string;
	sourceSha256: string;
	articleId: string;
};

async function deleteVectors(vectorIds: string[]) {
	for (let offset = 0; offset < vectorIds.length; offset += VECTOR_BATCH_SIZE) {
		const ids = vectorIds.slice(offset, offset + VECTOR_BATCH_SIZE);
		const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/v2/indexes/${vectorIndex}/delete_by_ids`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ ids }),
		});
		if (!response.ok) throw new Error(`Vectorize HTTP ${response.status}: ${await response.text()}`);
		const data = await response.json() as { success: boolean; errors?: unknown[] };
		if (!data.success) throw new Error(`Vectorize failed: ${JSON.stringify(data.errors)}`);
	}
}

async function reconcileStaleArticles(rows: ExistingArticle[]): Promise<number> {
	if (!rows.length) return 0;
	const articleIds = rows.map((row) => row.articleId);
	const vectorIds = new Set<string>();
	for (let offset = 0; offset < articleIds.length; offset += SQL_BATCH_SIZE) {
		const ids = articleIds.slice(offset, offset + SQL_BATCH_SIZE);
		const placeholders = ids.map(() => "?").join(",");
		const chunks = await query(`SELECT vector_id FROM chunks WHERE article_id IN (${placeholders})`, ids);
		for (const chunk of chunks) {
			if (typeof chunk.vector_id === "string" && chunk.vector_id) vectorIds.add(chunk.vector_id);
		}
	}
	// 先删 Vectorize，再删 D1；否则 articles 的 ON DELETE CASCADE 会丢掉清理向量所需的 vector_id。
	await deleteVectors([...vectorIds]);
	for (let offset = 0; offset < articleIds.length; offset += SQL_BATCH_SIZE) {
		const ids = articleIds.slice(offset, offset + SQL_BATCH_SIZE);
		const placeholders = ids.map(() => "?").join(",");
		await execute(`DELETE FROM articles WHERE article_id IN (${placeholders})`, ids);
	}
	return rows.length;
}

async function main() {
	const availableMonths = await discoverMonths(sourceRoot);
	const selectedMonths = monthSet.size > 0
		? availableMonths.filter((month) => monthSet.has(month))
		: availableMonths;
	if (!selectedMonths.length) throw new Error("no selected YYYYMM month directories found under " + sourceRoot);
	const files = await walk(sourceRoot, new Set(selectedMonths));
	// Parse the complete archive before the first remote write. A frontmatter failure
	// therefore never produces a partly ingested corpus.
	const articles = await Promise.all(files.map(async (file) => {
		const raw = await readFile(file, "utf8");
		// 统一正斜杠 source_path：article_id 由 source_path 派生，且 D1 按 source_path 去重；
		// 平台分隔符不一致会改变 ID 并造成重复入库。
		return parseArticle(raw, relative(sourceRoot, file).split(sep).join("/"));
	}));
	const searchableArticles = articles.filter((article) => article.content.length > 0);
	const metadataOnlyCount = articles.length - searchableArticles.length;
	// 增量导入：以 source_path -> source_sha256 为判据，内容未变的文件零写入跳过。
	// 首次运行（线上无记录）时全部视为新增，行为等同于全量导入。
	const existingRows = (await query("SELECT source_path, source_sha256, article_id FROM articles", [])).map((row): ExistingArticle => ({
		sourcePath: String(row.source_path),
		sourceSha256: String(row.source_sha256),
		articleId: String(row.article_id),
	}));
	const existing = new Map(existingRows.map((row) => [row.sourcePath, row.sourceSha256]));
	const localPaths = new Set(articles.map((article) => article.sourcePath));
	const selectedMonthSet = new Set(selectedMonths);
	const staleRows = existingRows.filter((row) => {
		const month = row.sourcePath.split("/", 1)[0];
		return selectedMonthSet.has(month) && !localPaths.has(row.sourcePath);
	});
	const runId = randomUUID();
	await execute("INSERT INTO ingest_runs(run_id, started_at, source_root, article_total) VALUES (?, datetime('now'), ?, ?)", [runId, sourceRoot, articles.length]);
	const deleted = await reconcileStaleArticles(staleRows);
	let inserted = 0;
	let changed = 0;
	let skipped = 0;
	for (const article of articles) {
		const remoteSha = existing.get(article.sourcePath);
		if (remoteSha === article.sourceSha256) {
			skipped++;
			continue;
		}
		await execute(`INSERT INTO articles(article_id, source_path, source_sha256, type, source, title, subtitle, author, published_date, page, theme, edition_type, headline, image, column_name, region, content)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(source_path) DO UPDATE SET source_sha256=excluded.source_sha256, type=excluded.type, source=excluded.source, title=excluded.title, subtitle=excluded.subtitle, author=excluded.author, published_date=excluded.published_date, page=excluded.page, theme=excluded.theme, edition_type=excluded.edition_type, headline=excluded.headline, image=excluded.image, column_name=excluded.column_name, region=excluded.region, content=excluded.content, imported_at=CURRENT_TIMESTAMP
		WHERE articles.source_sha256 <> excluded.source_sha256`, [article.articleId, article.sourcePath, article.sourceSha256, article.type, article.source, article.title, article.subtitle, JSON.stringify(article.author), article.date, article.page, article.theme, article.editionType, article.headline ? 1 : 0, article.image ? 1 : 0, JSON.stringify(article.columnName), JSON.stringify(article.region), article.content]);
		inserted++;
		if (remoteSha !== undefined) changed++;
	}
	await execute("UPDATE ingest_runs SET completed_at=datetime('now'), inserted_count=?, failed_count=0 WHERE run_id=?", [inserted, runId]);
	console.log(JSON.stringify({ runId, sourceRoot, articles: inserted, changed, skipped, deleted, searchableArticles: searchableArticles.length, metadataOnlyArticles: metadataOnlyCount }));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : error);
	process.exit(1);
});
