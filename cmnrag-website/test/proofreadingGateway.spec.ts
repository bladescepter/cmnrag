import { afterEach, describe, expect, it, vi } from "vitest";
import { handleProofreading, signIdentity } from "../src/proofreading/gateway";
import type { AuthUser } from "../src/auth";
import { verifyWorkerToken } from "../../proofreading-service/src/auth.js";

const user = { id: 7, status: "approved" } as AuthUser;
const configured = { PROOFREADING_BACKEND_URL: "https://proofreading.example.org/", PROOFREADING_SIGNING_SECRET: "test-only-signing-secret" };
const url = "https://cfzx.example.org/api/proofreading/tasks";
afterEach(() => vi.unstubAllGlobals());

describe("proofreading gateway", () => {
	it("rejects guests and disabled users without reaching backend", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		expect((await handleProofreading(new Request(url), configured, null)).status).toBe(401);
		expect((await handleProofreading(new Request(url), configured, { ...user, status: "rejected" })).status).toBe(403);
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("fails closed without backend configuration and denies cross-origin submissions", async () => {
		expect((await handleProofreading(new Request(url), {}, user)).status).toBe(503);
		expect((await handleProofreading(new Request(url, { method: "POST", headers: { origin: "https://other.example", "content-type": "application/json" }, body: "{}" }), configured, user)).status).toBe(403);
	});
	it("rejects arbitrary paths, oversize bodies and missing idempotency keys", async () => {
		expect((await handleProofreading(new Request(url + "/../../health"), configured, user)).status).toBe(404);
		expect((await handleProofreading(new Request(url, { method: "POST", headers: { origin: "https://cfzx.example.org", "content-type": "application/json" }, body: "{}" }), configured, user)).status).toBe(400);
		expect((await handleProofreading(new Request(url, { method: "POST", headers: { origin: "https://cfzx.example.org", "content-type": "application/json", "x-idempotency-key": "12345678-1234-1234-1234-123456789abc" }, body: JSON.stringify({ content: "x".repeat(210000) }) }), configured, user)).status).toBe(413);
	});
	it("passes only a short-lived signed identity and no browser cookie", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }), { headers: { "content-type": "application/json" } }));
		vi.stubGlobal("fetch", fetchMock);
		const response = await handleProofreading(new Request(url, { headers: { cookie: "private=session" } }), configured, user);
		expect(response.status).toBe(200);
		const [destination, init] = fetchMock.mock.calls[0];
		expect(destination).toBe("https://proofreading.example.org/api/proofreading/tasks");
		expect(init.headers.get("cookie")).toBeNull();
		const parts = init.headers.get("authorization").slice(7).split(".");
		const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
		expect(payload.sub).toBe("7");
		expect(payload.aud).toBe("proofreading-service");
		expect(payload.exp - payload.iat).toBe(60);
	});
	it("permits HTTP only for an explicitly enabled loopback Worker and fixed backend port", async () => {
		const localEnv = { PROOFREADING_BACKEND_URL: "http://127.0.0.1:8788/", PROOFREADING_SIGNING_SECRET: "local-test-only", PROOFREADING_LOCAL_LOOPBACK: "1" } as Env;
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ready: true }), { headers: { "content-type": "application/json" } }));
		vi.stubGlobal("fetch", fetchMock);
		const local = new Request("http://localhost:8787/api/proofreading/availability");
		expect((await handleProofreading(local, localEnv, user)).status).toBe(200);
		expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:8788/api/proofreading/availability");
		const calls = fetchMock.mock.calls.length;
		expect((await handleProofreading(new Request("https://cfzx.xiyuan.wiki/api/proofreading/availability"), localEnv, user)).status).toBe(503);
		expect((await handleProofreading(local, { ...localEnv, PROOFREADING_LOCAL_LOOPBACK: undefined } as Env, user)).status).toBe(503);
		expect((await handleProofreading(local, { ...localEnv, PROOFREADING_BACKEND_URL: "http://other.example/" } as Env, user)).status).toBe(503);
		expect(fetchMock).toHaveBeenCalledTimes(calls);
	});
	it("refuses upstream redirects instead of leaking the signed identity", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://untrusted.example/" } }));
		vi.stubGlobal("fetch", fetchMock);
		expect((await handleProofreading(new Request(url), configured, user)).status).toBe(502);
		expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
	});
	it("signs the exact JWT signing input", async () => {
		const jwt = await signIdentity(7, "test-secret", 100_000);
		const [header, payload, signature] = jwt.split(".");
		const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("test-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
		const bytes = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
		expect(await crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
		expect(verifyWorkerToken(`Bearer ${jwt}`, "test-secret", 100_000)).toBe(7);
	});
});
