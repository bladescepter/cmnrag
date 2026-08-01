import { readdir } from "node:fs/promises";
import { join } from "node:path";

export type EmbeddingMetadata = {
	title: string;
	author: string;
	date: string;
	page: string;
	theme: string;
	columnName: string;
	region: string;
};

export async function discoverJulyFiles(root: string): Promise<string[]> {
	const julyRoot = join(root, "202607");
	async function walk(directory: string): Promise<string[]> {
		const entries = await readdir(directory, { withFileTypes: true });
		const nested = await Promise.all(entries.map((entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return walk(path);
			return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
		}));
		return nested.flat();
	}
	return (await walk(julyRoot)).sort();
}

const value = (text: string) => text || "无";

export function buildEmbeddingText(metadata: EmbeddingMetadata, chunk: string): string {
	return [
		`标题：${metadata.title}`,
		`作者：${value(metadata.author)}`,
		`日期：${metadata.date}`,
		`版面：${metadata.page}`,
		`主题：${metadata.theme}`,
		`栏目：${value(metadata.columnName)}`,
		`地区：${value(metadata.region)}`,
		`正文：${chunk}`,
	].join("\n");
}
