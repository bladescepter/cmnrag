import { readdir } from "node:fs/promises";
import { join } from "node:path";

export type EmbeddingMetadata = {
	title: string;
	author: string[];
	date: string;
	page: string;
	theme: string;
	columnName: string[];
	region: string[];
};

export async function discoverMonthFiles(root: string, months: string[]): Promise<string[]> {
	async function walk(directory: string): Promise<string[]> {
		const entries = await readdir(directory, { withFileTypes: true });
		const nested = await Promise.all(entries.map((entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return walk(path);
			return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
		}));
		return nested.flat();
	}
	const results: string[] = [];
	for (const month of months) {
		try {
			results.push(...(await walk(join(root, month))));
		} catch {
			// 月份目录不存在则跳过
		}
	}
	return results.sort();
}

export async function discoverJulyFiles(root: string): Promise<string[]> {
	return discoverMonthFiles(root, ["202607"]);
}

const value = (text: string[] | undefined) => (text && text.length ? text.join("、") : "无");

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
