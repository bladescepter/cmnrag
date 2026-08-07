import { createHash } from "node:crypto";
import { parse } from "yaml";

export type Article = {
	articleId: string;
	sourcePath: string;
	type: string;
	source: string;
	title: string;
	subtitle: string;
	author: string[];
	date: string;
	page: string;
	theme: string;
	editionType: string;
	headline: boolean;
	image: boolean;
	columnName: string[];
	region: string[];
	content: string;
	sourceSha256: string;
};

type RawFrontmatter = Record<string, unknown>;

const requiredTextFields = ["type", "source", "title", "date", "page", "theme", "edition_type"] as const;

function textValue(frontmatter: RawFrontmatter, key: string, required = false): string {
	const value = frontmatter[key];
	if (value === undefined || value === null) {
		if (required) throw new Error(`Missing required frontmatter field: ${key}`);
		return "";
	}
	if (typeof value !== "string" && typeof value !== "number") {
		throw new Error(`Frontmatter field ${key} must be text`);
	}
	const text = String(value).trim();
	if (required && !text) throw new Error(`Missing required frontmatter field: ${key}`);
	return text;
}

function listTextValue(frontmatter: RawFrontmatter, key: string): string[] {
	const value = frontmatter[key];
	if (value === undefined || value === null || value === "") return [];
	if (typeof value === "string") return [value.trim()].filter(Boolean);
	if (typeof value === "number") return [String(value)];
	if (Array.isArray(value)) {
		return value
			.map((item) => {
				if (typeof item !== "string" && typeof item !== "number") {
					throw new Error(`Frontmatter field ${key} must be text or list of text`);
				}
				return String(item).trim();
			})
			.filter(Boolean);
	}
	throw new Error(`Frontmatter field ${key} must be text or list of text`);
}

function booleanValue(frontmatter: RawFrontmatter, key: string, fallback = false): boolean {
	const value = frontmatter[key];
	if (value === undefined || value === null || value === "") return fallback;
	if (typeof value === "boolean") return value;
	throw new Error(`Frontmatter field ${key} must be boolean`);
}

export function parseArticle(markdown: string, sourcePath: string): Article {
	const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) throw new Error(`Invalid Markdown frontmatter in ${sourcePath}`);

	const frontmatter = parse(match[1]) as RawFrontmatter;
	if (!frontmatter || Array.isArray(frontmatter)) throw new Error(`Invalid frontmatter object in ${sourcePath}`);
	for (const field of requiredTextFields) textValue(frontmatter, field, true);

	const date = textValue(frontmatter, "date", true);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Frontmatter date must use YYYY-MM-DD in ${sourcePath}`);
	const page = textValue(frontmatter, "page", true);
	if (!new Set(["一版", "二版", "三版", "四版"]).has(page)) throw new Error(`Frontmatter page is invalid in ${sourcePath}`);
	const editionType = textValue(frontmatter, "edition_type", true);
	if (!new Set(["常规版", "策划版"]).has(editionType)) throw new Error(`Frontmatter edition_type is invalid in ${sourcePath}`);

	const content = match[2].trim();

	return {
		articleId: createHash("sha256").update(sourcePath).digest("hex"),
		sourcePath,
		type: textValue(frontmatter, "type", true),
		source: textValue(frontmatter, "source", true),
		title: textValue(frontmatter, "title", true),
		subtitle: textValue(frontmatter, "subtitle"),
		author: listTextValue(frontmatter, "author"),
		date,
		page,
		theme: textValue(frontmatter, "theme", true),
		editionType,
		headline: booleanValue(frontmatter, "headline"),
		image: booleanValue(frontmatter, "image"),
		columnName: listTextValue(frontmatter, "column"),
		region: listTextValue(frontmatter, "region"),
		content,
		sourceSha256: createHash("sha256").update(markdown).digest("hex"),
	};
}
