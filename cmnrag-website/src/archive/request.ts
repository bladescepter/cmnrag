import type { ArticleFilters } from "./search";

export type SearchRequest = ArticleFilters & { keyword?: string };

function optionalBoolean(url: URL, key: string): boolean | undefined {
	const value = url.searchParams.get(key);
	if (value === null) return undefined;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`${key} must be true or false`);
}

export function parseSearchRequest(url: URL): SearchRequest {
	const text = (key: string) => url.searchParams.get(key)?.trim() || undefined;
	const request: SearchRequest = {};
	const keyword = text("q");
	const page = url.searchParams.getAll("page").map((value) => value.trim()).filter(Boolean);
	const theme = url.searchParams.getAll("theme").map((value) => value.trim()).filter(Boolean);
	const assignText = (key: "columnName" | "regionPrefix" | "author" | "dateFrom" | "dateTo", param: string) => {
		const value = text(param);
		if (value) request[key] = value;
	};
	if (keyword) request.keyword = keyword;
	if (page.length) request.page = page;
	if (theme.length) request.theme = theme;
	assignText("columnName", "column");
	assignText("regionPrefix", "region");
	assignText("author", "author");
	assignText("dateFrom", "date_from");
	assignText("dateTo", "date_to");
	const headline = optionalBoolean(url, "headline");
	const image = optionalBoolean(url, "image");
	if (headline !== undefined) request.headline = headline;
	if (image !== undefined) request.image = image;
	return request;
}
