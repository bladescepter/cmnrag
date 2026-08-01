import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("中国气象报检索 Worker", () => {
	it("exposes a public health endpoint", async () => {
		const response = await worker.fetch(new Request("https://example.com/health"), {} as Env, {} as ExecutionContext);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});

	it("does not expose a query result before the archive is initialized", async () => {
		const response = await worker.fetch(new Request("https://example.com/api/search?q=河北"), {} as Env, {} as ExecutionContext);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "archive_not_initialized" });
	});
});
