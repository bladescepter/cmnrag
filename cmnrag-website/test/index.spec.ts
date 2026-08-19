import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("中国气象报检索 Worker", () => {
	it("exposes a public health endpoint", async () => {
		const response = await worker.fetch(new Request("https://example.com/health"), {} as Env, {} as ExecutionContext);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});

	it("requires authentication for API queries", async () => {
		const response = await worker.fetch(new Request("https://example.com/api/search?q=河北"), {} as Env, {} as ExecutionContext);
		expect(response.status).toBe(401);
	});
});
