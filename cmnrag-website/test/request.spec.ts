import { describe, expect, it } from "vitest";
import { parseSearchRequest } from "../src/archive/request";

describe("parseSearchRequest", () => {
	it("parses only supported archive filters", () => {
		const filters = parseSearchRequest(new URL("https://example.com/api/articles?q=防雷&page=二版&page=三版&region=河北省&headline=true"));
		expect(filters).toEqual({ keyword: "防雷", page: ["二版", "三版"], regionPrefix: "河北省", headline: true });
	});

	it("parses a partial column phrase for catalogue matching", () => {
		const filters = parseSearchRequest(new URL("https://example.com/api/articles?column=防灾减灾第一道防线"));
		expect(filters).toEqual({ columnName: "防灾减灾第一道防线" });
	});

	it("rejects invalid booleans instead of guessing", () => {
		expect(() => parseSearchRequest(new URL("https://example.com/api/articles?headline=yes"))).toThrow("headline");
	});
});
