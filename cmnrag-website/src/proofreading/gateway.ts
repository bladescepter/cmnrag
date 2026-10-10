import { canProofread, type AuthUser } from "../auth";

/** Only these paths can cross the Worker → proofreading service boundary. */
const ROOT = "/api/proofreading";
const TASK = /^\/api\/proofreading\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const MAX_REQUEST = 200_000;
const MAX_RESPONSE = 1_000_000;
const encoder = new TextEncoder();

async function readLimited(response: Request | Response, maxBytes: number): Promise<string | null> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) { await reader.cancel(); return null; }
			chunks.push(value);
		}
	} finally { reader.releaseLock(); }
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	return new TextDecoder().decode(bytes);
}

type BackendEnv = { PROOFREADING_BACKEND_URL?: string; PROOFREADING_SIGNING_SECRET?: string; PROOFREADING_LOCAL_LOOPBACK?: string };
const reply = (error: string, status: number) => new Response(JSON.stringify({ error }), {
	status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

function base64url(data: Uint8Array): string {
	let binary = "";
	for (const byte of data) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The backend MUST verify signature, audience, expiry and user ownership on every request. */
export async function signIdentity(userId: number, secret: string, now = Date.now()): Promise<string> {
	const header = base64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
	const payload = base64url(encoder.encode(JSON.stringify({ sub: String(userId), aud: "proofreading-service", iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 60 })));
	const input = `${header}.${payload}`;
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return `${input}.${base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(input))))}`;
}

export async function handleProofreading(request: Request, env: Env, user: AuthUser | null): Promise<Response> {
	if (!user || user.status !== "approved") return reply(user ? "forbidden" : "unauthorized", user ? 403 : 401);
	if (!canProofread(user)) return reply("proofreading_forbidden", 403);
	const requestUrl = new URL(request.url);
	const path = requestUrl.pathname;
	const localRequest = requestUrl.hostname === "localhost" || requestUrl.hostname === "127.0.0.1";
	const method = request.method;
	const valid = (path === `${ROOT}/availability` && method === "GET")
		|| (path === `${ROOT}/tasks` && (method === "GET" || method === "POST"))
		|| (TASK.test(path) && method === "GET");
	if (!valid) return reply("not_found", 404);
	const origin = new URL(request.url).origin;
	if (method === "POST") {
		if (request.headers.get("origin") !== origin) return reply("invalid_origin", 403);
		if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return reply("invalid_content_type", 415);
		const length = Number(request.headers.get("content-length"));
		if (length > MAX_REQUEST) return reply("request_too_large", 413);
	}
	const { PROOFREADING_BACKEND_URL: base, PROOFREADING_SIGNING_SECRET: secret, PROOFREADING_LOCAL_LOOPBACK: localLoopback } = env as Env & BackendEnv;
	if (localLoopback === "1" && !localRequest) return reply("local_worker_request_host_mismatch", 503);
	if (!base || !secret) return reply(localRequest ? "local_gateway_config_missing" : "service_unavailable", 503);
	let backend: URL;
	try {
		backend = new URL(base);
		const localHttp = localLoopback === "1" && localRequest
			&& backend.protocol === "http:" && backend.hostname === "127.0.0.1" && backend.port === "8788";
		if ((backend.protocol !== "https:" && !localHttp) || backend.username || backend.password || backend.search || backend.hash || backend.pathname !== "/") throw new Error("invalid backend URL");
	} catch {
		return reply(localRequest ? "local_backend_url_rejected" : "service_unavailable", 503);
	}
	let body: string | undefined;
	if (method === "POST") {
		body = (await readLimited(request, MAX_REQUEST)) ?? undefined;
		if (body === undefined) return reply("request_too_large", 413);
		try { JSON.parse(body); } catch { return reply("invalid_json", 400); }
	}
	const idempotencyKey = request.headers.get("x-idempotency-key");
	if (method === "POST" && (!idempotencyKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idempotencyKey))) return reply("invalid_idempotency_key", 400);
	backend.pathname = path;
	try {
		const token = await signIdentity(user.id, secret);
		const headers = new Headers({ authorization: `Bearer ${token}`, accept: "application/json" });
		if (body !== undefined) {
			headers.set("content-type", "application/json");
			headers.set("x-idempotency-key", idempotencyKey!);
		}
		const response = await fetch(backend.toString(), { method, headers, body, redirect: "manual" });
		if (response.status >= 300 && response.status < 400) return reply("service_unavailable", 502);
		if (response.status >= 500) return reply(localRequest ? "local_upstream_5xx" : "service_unavailable", 503);
		if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) return reply("invalid_backend_response", 502);
		if (Number(response.headers.get("content-length")) > MAX_RESPONSE) return reply("invalid_backend_response", 502);
		const text = await readLimited(response, MAX_RESPONSE);
		if (text === null) return reply("invalid_backend_response", 502);
		try { JSON.parse(text); } catch { return reply("invalid_backend_response", 502); }
		return new Response(text, { status: response.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
	} catch {
		return reply(localRequest ? "local_backend_unreachable" : "service_unavailable", 503);
	}
}
