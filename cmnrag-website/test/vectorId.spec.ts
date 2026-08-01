import { describe, expect, it } from "vitest";
import { vectorIdForChunk } from "../src/ingest/vectorId";

describe("vectorIdForChunk", () => {
	it("creates a stable Vectorize-safe ID", () => {
		const id = vectorIdForChunk("f".repeat(64), 12);
		expect(id).toHaveLength(64);
		expect(id).toBe(vectorIdForChunk("f".repeat(64), 12));
		expect(id).not.toBe(vectorIdForChunk("f".repeat(64), 13));
	});
});
