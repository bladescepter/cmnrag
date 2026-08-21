// 全局设置路由 (人员名单 + 周五轮换顺序)
// 认证由主 Worker 统一处理，此处不再挂内部 sessionMiddleware

import { Hono } from 'hono';
import type { Env } from '../index';

export const settingsRoutes = new Hono<{ Bindings: Env }>();

/** 读取全局设置 */
settingsRoutes.get('/', async c => {
  let row = await c.env.PB_DB.prepare('SELECT * FROM settings WHERE id = 1').first<{
    members_json: string;
    friday_rotation_json: string;
    exclusions_json: string;
  }>();
  if (!row) {
    await c.env.PB_DB.prepare(
      `INSERT INTO settings (id, members_json, friday_rotation_json) VALUES (1, '[]', '[]')`
    ).run();
    row = await c.env.PB_DB.prepare('SELECT * FROM settings WHERE id = 1').first<{
      members_json: string;
      friday_rotation_json: string;
      exclusions_json: string;
    }>();
  }
  return c.json({
    members: JSON.parse(row!.members_json),
    fridayRotation: JSON.parse(row!.friday_rotation_json),
    exclusions: JSON.parse(row!.exclusions_json ?? '[]'),
  });
});

/** 更新全局设置 (需登录, 简化权限: 任何登录用户可改) */
settingsRoutes.put('/', async c => {
  const body = await c.req.json<{
    members?: unknown;
    fridayRotation?: unknown;
    exclusions?: unknown;
  }>();
  const { members, fridayRotation, exclusions } = body;
  await c.env.PB_DB.prepare(
    `UPDATE settings SET members_json = ?, friday_rotation_json = ?, exclusions_json = ?, updated_at = datetime('now') WHERE id = 1`
  ).bind(
    JSON.stringify(members ?? []),
    JSON.stringify(fridayRotation ?? []),
    JSON.stringify(exclusions ?? [])
  ).run();
  return c.json({ ok: true });
});
