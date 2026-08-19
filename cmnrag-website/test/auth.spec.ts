import { describe, expect, it } from "vitest";
import {
	handleAdminAction,
	handleAdminUsers,
	handleLogin,
	handleLogout,
	handleMe,
	handleRegister,
	hashPassword,
	requireUser,
	verifyPassword,
} from "../src/auth";

type UserRow = { id: number; username: string; password_hash: string; display_name: string; email: string; note: string; role: string; status: string; rejected_reason: string; created_at: string; approved_at: string | null };
type SessionRow = { token: string; user_id: number; expires_at: string };

/** 最小内存 D1 fake：仅覆盖 auth 相关 SQL 形态 */
class FakeD1 {
	users: UserRow[] = [];
	sessions: SessionRow[] = [];
	private nextId = 1;

	prepare(sql: string) {
		const self = this;
		// prepare() 直接可用（无参数，D1 语义），bind(...) 返回带参数版本
		const stmt = (...params: unknown[]) => ({
			async first<T = unknown>(): Promise<T | null> {
				if (sql.includes("password_hash") && sql.includes("WHERE username = ?")) {
					const u = self.users.find((x) => x.username === params[0]);
					return (u ? { id: u.id, password_hash: u.password_hash, status: u.status, role: u.role } : null) as T | null;
				}
					if (sql.includes("FROM users WHERE username = ?")) {
						const u = self.users.find((x) => x.username === params[0]);
						return (u ? { id: u.id, username: u.username } : null) as T | null;
					}
					if (sql.includes("JOIN users")) {
						const s = self.sessions.find((x) => x.token === params[0] && x.expires_at > new Date().toISOString());
						if (!s) return null;
						const u = self.users.find((x) => x.id === s.user_id);
						return (u ? { id: u.id, username: u.username, display_name: u.display_name, email: u.email, note: u.note, role: u.role, status: u.status, created_at: u.created_at } : null) as T | null;
					}
					return null;
				},
				async all<T = unknown>(): Promise<{ results: T[] }> {
					if (sql.includes("FROM users")) {
						const status = params[0] as string | undefined;
						const rows = status ? self.users.filter((u) => u.status === status) : self.users;
						return { results: rows as unknown as T[] };
					}
					return { results: [] as T[] };
				},
				async run(): Promise<{ success: boolean }> {
					if (sql.includes("INSERT INTO users")) {
						const [username, password_hash, displayName, email, note, role, status] = params as string[];
						self.users.push({ id: self.nextId++, username, password_hash, display_name: displayName, email, note, role, status, rejected_reason: "", created_at: new Date().toISOString(), approved_at: status === "approved" ? new Date().toISOString() : null });
					} else if (sql.includes("INSERT INTO sessions")) {
						const [token, userId, expiresAt] = params as [string, number, string];
						self.sessions.push({ token, user_id: userId, expires_at: expiresAt });
					} else if (sql.includes("UPDATE users SET status = 'approved'")) {
						const u = self.users.find((x) => x.id === Number(params[0]));
						if (u) { u.status = "approved"; u.rejected_reason = ""; u.approved_at = new Date().toISOString(); }
					} else if (sql.includes("UPDATE users SET status = 'rejected'")) {
						const [reason, id] = params as [string, number];
						const u = self.users.find((x) => x.id === Number(id));
						if (u) { u.status = "rejected"; u.rejected_reason = reason; u.approved_at = null; }
					} else if (sql.includes("DELETE FROM sessions WHERE token = ?")) {
						self.sessions = self.sessions.filter((s) => s.token !== params[0]);
					} else if (sql.includes("DELETE FROM sessions WHERE expires_at")) {
						self.sessions = self.sessions.filter((s) => s.expires_at > new Date().toISOString());
					}
					return { success: true };
				},
		});
		return {
			...stmt(),
			bind: (...params: unknown[]) => stmt(...params),
		};
	}
}

function makeEnv(db: FakeD1, initSecret = "secret-init-1") {
	return { DB: db, ADMIN_INIT_SECRET: initSecret } as unknown as Env;
}

function req(path: string, init: RequestInit = {}): Request {
	return new Request(`https://example.com${path}`, init);
}

function cookieFrom(response: Response): string {
	const setCookie = response.headers.get("set-cookie") ?? "";
	return setCookie.split(";")[0];
}

describe("认证模块", () => {
	it("hashPassword/verifyPassword 往返正确", async () => {
		const stored = await hashPassword("password123");
		expect(stored.split(".")).toHaveLength(3);
		expect(await verifyPassword("password123", stored)).toBe(true);
		expect(await verifyPassword("wrong", stored)).toBe(false);
	});

	it("注册默认 pending，不能登录", async () => {
		const env = makeEnv(new FakeD1());
		const reg = await handleRegister(req("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "zhangsan", password: "password123", note: "记者" }) }), env);
		expect(reg.status).toBe(200);
		expect(await reg.json()).toMatchObject({ status: "pending" });
		const login = await handleLogin(req("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "zhangsan", password: "password123" }) }), env);
		expect(login.status).toBe(403);
	});

	it("带初始化密钥注册直接成为 admin", async () => {
		const env = makeEnv(new FakeD1());
		const reg = await handleRegister(req("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin1", password: "password123", init_code: "secret-init-1" }) }), env);
		expect(reg.status).toBe(200);
		expect(await reg.json()).toMatchObject({ role: "admin", status: "approved" });
	});

	it("审批通过后可登录，me 返回用户，未登录 401", async () => {
		const db = new FakeD1();
		const env = makeEnv(db);
		await handleRegister(req("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "lisi", password: "password123" }) }), env);
		await handleAdminAction(req("/api/admin/users/1/approve", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), env, "1", "approve");
		const login = await handleLogin(req("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "lisi", password: "password123" }) }), env);
		expect(login.status).toBe(200);
		const token = cookieFrom(login);
		const me = await handleMe(await requireUser(req("/api/auth/me", { headers: { cookie: token } }), env));
		expect(me.status).toBe(200);
		expect((await me.json())).toMatchObject({ user: { username: "lisi", role: "user" } });
		const anon = await handleMe(null);
		expect(anon.status).toBe(401);
	});

	it("错误密码 401；待审批用户被拒后仍不能登录", async () => {
		const env = makeEnv(new FakeD1());
		await handleRegister(req("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "wangwu", password: "password123" }) }), env);
		const bad = await handleLogin(req("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "wangwu", password: "wrong-pass" }) }), env);
		expect(bad.status).toBe(401);
		await handleAdminAction(req("/api/admin/users/1/reject", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "非本单位" }) }), env, "1", "reject");
		const rejected = await handleLogin(req("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "wangwu", password: "password123" }) }), env);
		expect(rejected.status).toBe(403);
	});

	it("admin 列表与审批；logout 后会话失效", async () => {
		const db = new FakeD1();
		const env = makeEnv(db);
		await handleRegister(req("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "zhangsan", password: "password123" }) }), env);
		const list = await handleAdminUsers(new URL("https://example.com/api/admin/users?status=pending"), env);
		expect(list.status).toBe(200);
		expect((await list.json())).toMatchObject({ items: [{ username: "zhangsan" }] });
		await handleAdminAction(req("/api/admin/users/1/approve", { method: "POST" }), env, "1", "approve");
		const login = await handleLogin(req("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "zhangsan", password: "password123" }) }), env);
		const token = cookieFrom(login);
		expect((await requireUser(req("/api/auth/me", { headers: { cookie: token } }), env))?.username).toBe("zhangsan");
		await handleLogout(req("/api/auth/logout", { method: "POST", headers: { cookie: token } }), env);
		expect(await requireUser(req("/api/auth/me", { headers: { cookie: token } }), env)).toBeNull();
	});

	it("用户名重复注册 409；非法用户名 400", async () => {
		const env = makeEnv(new FakeD1());
		const body = JSON.stringify({ username: "zhangsan", password: "password123" });
		await handleRegister(req("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body }), env);
		const dup = await handleRegister(req("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body }), env);
		expect(dup.status).toBe(409);
		const bad = await handleRegister(req("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "a!b", password: "password123" }) }), env);
		expect(bad.status).toBe(400);
	});
});
