import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("proofreading page legacy alias", () => {
	it.each(["/proofread", "/proofread/", "/proofread/index.html"])("redirects %s without accessing user data", async (path) => {
		const response = await worker.fetch(new Request(`http://127.0.0.1:8787${path}?task=abc`), {} as Env, {} as ExecutionContext);
		expect(response.status).toBe(308);
		expect(response.headers.get("location")).toBe("http://127.0.0.1:8787/proofreading/?task=abc");
	});
});
