-- 注册-审批-登录体系：用户与会话表
-- 用户在 /login.html 提交注册申请（status=pending），管理员在 /admin.html 审批通过/拒绝；
-- 仅 status=approved 用户可登录；role=admin 者可访问审批接口。

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,              -- 格式: saltBase64.iterations.hashBase64 (PBKDF2-SHA256)
  display_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',            -- 申请备注（单位/用途）
  role TEXT NOT NULL DEFAULT 'user',        -- admin / user
  status TEXT NOT NULL DEFAULT 'pending',   -- pending / approved / rejected
  rejected_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
