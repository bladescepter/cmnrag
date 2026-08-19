/**
 * 注册-审批-登录认证
 * - 密码：PBKDF2-SHA256 加盐哈希（Workers Web Crypto）
 * - 会话：随机 token 存 D1 sessions 表，HttpOnly Cookie，默认 7 天
 * - 审批：注册默认 pending，管理员 approve/reject；携带 init_code 且匹配 ADMIN_INIT_SECRET 时直接成为 admin
 */

export const SESSION_COOKIE = "cmnrag_session";
const SESSION_DAYS = 7;
const PBKDF2_ITERATIONS = 100_000;

export type AuthUser = {
	id: number;
	username: string;
	display_name: string;
	email: string;
	note: string;
	role: string;
	status: string;
	created_at: string;
};

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});

const error = (message: string, status: number) => json({ error: message }, status);

// ---------- 密码哈希 ----------
function bufToB64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin);
}

function b64ToBuf(b64: string): Uint8Array {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
	return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
	return `${bufToB64(salt.buffer)}.${PBKDF2_ITERATIONS}.${bufToB64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [saltB64, iterStr, hashB64] = stored.split(".");
	if (!saltB64 || !iterStr || !hashB64) return false;
	const iterations = Number(iterStr);
	if (!Number.isFinite(iterations) || iterations <= 0) return false;
	const salt = b64ToBuf(saltB64);
	const hash = await pbkdf2(password, salt, iterations);
	return bufToB64(hash) === hashB64;
}

// ---------- 会话 / Cookie ----------
function newToken(): string {
	return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

export function parseCookies(request: Request): Record<string, string> {
	const header = request.headers.get("cookie") ?? "";
	const out: Record<string, string> = {};
	for (const part of header.split(";")) {
		const idx = part.indexOf("=");
		if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
	}
	return out;
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
	return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

const clearCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** 校验请求会话 → 返回用户（未登录/DB 异常返回 null） */
export async function requireUser(request: Request, env: Env): Promise<AuthUser | null> {
	const token = parseCookies(request)[SESSION_COOKIE];
	if (!token) return null;
	try {
		const row = await env.DB.prepare(
			"SELECT u.id, u.username, u.display_name, u.email, u.note, u.role, u.status, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > datetime('now')"
		).bind(token).first<AuthUser>();
		if (!row) return null;
		// 惰性清理过期会话
		await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run().catch(() => {});
		return row;
	} catch {
		return null;
	}
}

// ---------- 接口 ----------
type RegisterBody = { username?: unknown; password?: unknown; display_name?: unknown; email?: unknown; note?: unknown; init_code?: unknown };

export async function handleRegister(request: Request, env: Env): Promise<Response> {
	let body: RegisterBody;
	try {
		body = await request.json() as RegisterBody;
	} catch {
		return error("invalid_json", 400);
	}
	const username = typeof body.username === "string" ? body.username.trim() : "";
	const password = typeof body.password === "string" ? body.password : "";
	const displayName = typeof body.display_name === "string" ? body.display_name.trim().slice(0, 40) : "";
	const email = typeof body.email === "string" ? body.email.trim().slice(0, 120) : "";
	const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) : "";
	const initCode = typeof body.init_code === "string" ? body.init_code.trim() : "";
	if (!/^[\u4e00-\u9fffA-Za-z0-9_]{2,24}$/.test(username)) return error("用户名须为 2-24 位中文/字母/数字/下划线", 400);
	if (password.length < 8 || password.length > 128) return error("密码长度须为 8-128 位", 400);
	try {
		const exists = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first<{ id: number }>();
		if (exists) return error("用户名已存在", 409);
	} catch {
		return error("database_unavailable", 503);
	}
	const passwordHash = await hashPassword(password);
	const isAdminInit = Boolean(env.ADMIN_INIT_SECRET) && initCode === env.ADMIN_INIT_SECRET;
	const role = isAdminInit ? "admin" : "user";
	const status = isAdminInit ? "approved" : "pending";
	try {
		await env.DB.prepare(
			"INSERT INTO users (username, password_hash, display_name, email, note, role, status, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE NULL END)"
		).bind(username, passwordHash, displayName, email, note, role, status, isAdminInit ? "init" : null).run();
	} catch {
		return error("database_unavailable", 503);
	}
	return json({ ok: true, status, role });
}

type LoginBody = { username?: unknown; password?: unknown };

export async function handleLogin(request: Request, env: Env): Promise<Response> {
	let body: LoginBody;
	try {
		body = await request.json() as LoginBody;
	} catch {
		return error("invalid_json", 400);
	}
	const username = typeof body.username === "string" ? body.username.trim() : "";
	const password = typeof body.password === "string" ? body.password : "";
	if (!username || !password) return error("username_and_password_required", 400);
	let row: { id: number; password_hash: string; status: string; role: string } | null = null;
	try {
		row = await env.DB.prepare("SELECT id, password_hash, status, role FROM users WHERE username = ?").bind(username).first();
	} catch {
		return error("database_unavailable", 503);
	}
	if (!row) return error("用户名或密码错误", 401);
	if (!(await verifyPassword(password, row.password_hash))) return error("用户名或密码错误", 401);
	if (row.status === "pending") return error("账号待审批，请等待管理员通过", 403);
	if (row.status === "rejected") return error("账号申请未通过", 403);
	const token = newToken();
	const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
	try {
		await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").bind(token, row.id, expiresAt).run();
	} catch {
		return error("database_unavailable", 503);
	}
	return new Response(JSON.stringify({ ok: true, role: row.role }), {
		status: 200,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"set-cookie": sessionCookie(token, SESSION_DAYS * 24 * 3600),
		},
	});
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
	const token = parseCookies(request)[SESSION_COOKIE];
	if (token) {
		try {
			await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
		} catch {
			/* 忽略清理失败 */
		}
	}
	return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "set-cookie": clearCookie() } });
}

export function handleMe(user: AuthUser | null): Response {
	if (!user) return error("unauthorized", 401);
	return json({ user: { username: user.username, display_name: user.display_name, email: user.email, role: user.role, status: user.status } });
}

/** 管理员：列出用户（默认 pending，可 ?status=approved/rejected/all） */
export async function handleAdminUsers(url: URL, env: Env): Promise<Response> {
	const status = url.searchParams.get("status") ?? "pending";
	const allowed = ["pending", "approved", "rejected", "all"];
	if (!allowed.includes(status)) return error("invalid_status", 400);
	let sql = "SELECT id, username, display_name, email, note, role, status, rejected_reason, created_at, approved_at FROM users";
	const params: unknown[] = [];
	if (status !== "all") {
		sql += " WHERE status = ?";
		params.push(status);
	}
	sql += " ORDER BY id ASC";
	try {
		const result = await env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>();
		return json({ items: result.results });
	} catch {
		return error("database_unavailable", 503);
	}
}

/** 管理员：审批（approve / reject） */
export async function handleAdminAction(request: Request, env: Env, idText: string, action: "approve" | "reject"): Promise<Response> {
	const id = Number(idText);
	if (!Number.isInteger(id) || id <= 0) return error("invalid_id", 400);
	let reason = "";
	if (action === "reject") {
		try {
			const body = await request.json() as { reason?: unknown };
			reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : "";
		} catch {
			/* 无正文时 reason 为空 */
		}
	}
	try {
		if (action === "approve") {
			await env.DB.prepare("UPDATE users SET status = 'approved', rejected_reason = '', approved_at = datetime('now') WHERE id = ?").bind(id).run();
		} else {
			await env.DB.prepare("UPDATE users SET status = 'rejected', rejected_reason = ?, approved_at = NULL WHERE id = ?").bind(reason, id).run();
		}
	} catch {
		return error("database_unavailable", 503);
	}
	return json({ ok: true });
}
