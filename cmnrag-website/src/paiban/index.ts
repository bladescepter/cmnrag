// Hono 应用入口 - Cloudflare Worker
// 已并入 china-meteo-rag (cfzx.xiyuan.wiki)：作为子应用挂载在 /api/pb/* 前缀下。
// 认证已统一到主系统（主 Worker 的 requireUser 门禁），此处不再有独立注册/登录。
// 绑定名：DB → PB_DB（paiban D1 库）。

import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { scheduleRoutes } from './routes/schedule';
import { settingsRoutes } from './routes/settings';
import { calendarRoutes } from './routes/calendar';

export interface Env {
  PB_DB: D1Database;
}

type AppEnv = { Bindings: Env };

const app = new Hono<AppEnv>();

app.use('*', logger());

// API 路由（鉴权由主 Worker 统一处理）
app.route('/api/pb/calendar', calendarRoutes);
app.route('/api/pb/settings', settingsRoutes);
app.route('/api/pb/schedule', scheduleRoutes);

// 健康检查
app.get('/api/pb/health', c => c.json({ ok: true }));

export default app;
