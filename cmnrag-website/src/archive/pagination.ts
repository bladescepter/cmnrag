export type Pagination = { limit: number; offset: number };

export function parsePagination(url: URL): Pagination {
	const integer = (key: "limit" | "offset", fallback: number) => {
		const raw = url.searchParams.get(key);
		if (raw === null) return fallback;
		if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a non-negative integer`);
		return Number(raw);
	};
	const limit = integer("limit", 50);
	const offset = integer("offset", 0);
	if (limit < 1 || limit > 100) throw new Error("limit must be between 1 and 100");
	return { limit, offset };
}
