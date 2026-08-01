import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parseArticle } from "../src/archive/parseArticle";

// 默认指向仓库内数据根目录（<项目根>/cmnrag），可用第一个参数覆盖；
// 以脚本位置为锚，不依赖运行时 cwd。
const sourceRoot = process.argv[2] ?? join(__dirname, "..", "..", "cmnrag");
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "6af7ecfe8e736f150bae5089463f9293";
const token = process.env.CLOUDFLARE_RAG_API_TOKEN;
const databaseId = "f0fbe6ce-5e87-4885-9ab6-7e948ec13c4d";
if (!token) throw new Error("CLOUDFLARE_RAG_API_TOKEN is required");

async function walk(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? walk(join(directory, entry.name)) : entry.name.endsWith(".md") && /^2026\d{4}$/.test(directory.split(/[\\/]/).at(-2) ?? "") ? [join(directory, entry.name)] : []));
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

async function main() {
	const files = await walk(sourceRoot);
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
	const runId = randomUUID();
	await execute("INSERT INTO ingest_runs(run_id, started_at, source_root, article_total) VALUES (?, datetime('now'), ?, ?)", [runId, sourceRoot, articles.length]);
	let inserted = 0;
	for (const article of articles) {
		await execute(`INSERT INTO articles(article_id, source_path, source_sha256, type, source, title, subtitle, author, published_date, page, theme, edition_type, headline, image, column_name, region, content)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(source_path) DO UPDATE SET source_sha256=excluded.source_sha256, type=excluded.type, source=excluded.source, title=excluded.title, subtitle=excluded.subtitle, author=excluded.author, published_date=excluded.published_date, page=excluded.page, theme=excluded.theme, edition_type=excluded.edition_type, headline=excluded.headline, image=excluded.image, column_name=excluded.column_name, region=excluded.region, content=excluded.content, imported_at=CURRENT_TIMESTAMP
		WHERE articles.source_sha256 <> excluded.source_sha256`, [article.articleId, article.sourcePath, article.sourceSha256, article.type, article.source, article.title, article.subtitle, article.author, article.date, article.page, article.theme, article.editionType, article.headline ? 1 : 0, article.image ? 1 : 0, article.columnName, article.region, article.content]);
		inserted++;
	}
	await execute("UPDATE ingest_runs SET completed_at=datetime('now'), inserted_count=?, failed_count=0 WHERE run_id=?", [inserted, runId]);
	console.log(JSON.stringify({ runId, sourceRoot, articles: inserted, searchableArticles: searchableArticles.length, metadataOnlyArticles: metadataOnlyCount }));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : error);
	process.exit(1);
});
