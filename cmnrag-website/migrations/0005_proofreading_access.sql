-- 普通账户默认无测试校对权限；管理员保留校对权限。
-- 由管理员在用户审批页为已通过的普通账户单独开启。
ALTER TABLE users ADD COLUMN proofreading_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (proofreading_enabled IN (0, 1));
