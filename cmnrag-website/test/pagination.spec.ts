import { describe, expect, it } from "vitest";
import { parsePagination } from "../src/archive/pagination";

describe("parsePagination", () => {
	it("uses the initial 50-item page by default", () => {
		expect(parsePagination(new URL("https://example.com/api/articles"))).toEqual({ limit: 50, offset: 0 });
	});

	it("accepts a later page offset", () => {
		expect(parsePagination(new URL("https://example.com/api/articles?limit=50&offset=100"))).toEqual({ limit: 50, offset: 100 });
	});

	it("rejects oversized or invalid pagination", () => {
		expect(() => parsePagination(new URL("https://example.com/api/articles?limit=101"))).toThrow("limit");
		expect(() => parsePagination(new URL("https://example.com/api/articles?offset=-1"))).toThrow("offset");
	});
});
