-- 排班工具 D1 数据库 Schema
-- SQLite 语法 (D1 兼容)

-- 用户表 (多用户低保密)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 注：sessions 表已废弃删除（2026-08-21 认证统一到主系统后不再使用）

-- 见报日历表 (后端配置, 全局共享)
-- 每行一个日期: type 为 'publish'(见报) 或 'holiday'(休刊)
-- 见报日历也可由 "默认工作日见报 + holidays 列表" 派生, 此表存储显式覆盖
CREATE TABLE IF NOT EXISTS calendar (
  date TEXT PRIMARY KEY,            -- YYYY-MM-DD
  type TEXT NOT NULL,               -- 'publish' | 'holiday'
  name TEXT,                        -- 节日名称 (休刊时)
  source TEXT DEFAULT 'manual',     -- 'manual' | 'seed'
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_calendar_type ON calendar(type);

-- 排班表 (按用户隔离)
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  duty_date TEXT NOT NULL,          -- 值班日期 YYYY-MM-DD
  publish_date TEXT NOT NULL,       -- 见报日期 YYYY-MM-DD
  weekday TEXT NOT NULL,            -- 值班星期 (周一..周五)
  first_editor TEXT,                -- 一版编辑
  second_editor TEXT,               -- 二版编辑
  remark TEXT,                      -- 备注
  sort_order INTEGER,               -- 排序 (按值班日期)
  locked_first INTEGER NOT NULL DEFAULT 0,   -- 一版格子锁定: 1=生成时保留该格
  locked_second INTEGER NOT NULL DEFAULT 0,  -- 二版格子锁定: 1=生成时保留该格
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, duty_date)
);
CREATE INDEX IF NOT EXISTS idx_schedules_user_date ON schedules(user_id, duty_date);

-- 全局设置 (人员名单 / 轮换顺序 / 休假管理, 全局共享单行)
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  members_json TEXT NOT NULL,
  friday_rotation_json TEXT NOT NULL,
  exclusions_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
