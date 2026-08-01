import { describe, expect, it } from "vitest";
import { buildFacetQuery } from "../src/archive/facets";

describe("buildFacetQuery", () => {
	it("sorts unmatched candidates by frequency then name", () => {
		const query = buildFacetQuery("column_name");
		expect(query.sql).toContain("ORDER BY count DESC, value ASC");
		expect(query.params).toEqual([]);
	});

	it("sorts prefix matches before later partial matches", () => {
		const query = buildFacetQuery("theme", "气象科技");
		expect(query.sql).toContain("CASE WHEN value LIKE ? THEN 0 ELSE 1 END ASC");
		expect(query.params).toEqual(["%气象科技%", "气象科技%"]);
	});

	it("rejects fields outside the metadata facet allowlist", () => {
		expect(() => buildFacetQuery("content")).toThrow("Unsupported facet");
	});
});
