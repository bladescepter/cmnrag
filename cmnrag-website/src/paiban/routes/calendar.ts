// 见报日历路由

import { Hono } from 'hono';
import { CalendarIndex, computeAllCycles, type CalendarEntry } from '../engine';
import type { Env } from '../index';

export const calendarRoutes = new Hono<{ Bindings: Env }>();

/** 获取某年见报日历 (返回所有显式记录) */
calendarRoutes.get('/', async c => {
  const year = c.req.query('year') ?? new Date().getFullYear().toString();
  const rows = await c.env.PB_DB.prepare(
    `SELECT date, type, name FROM calendar
     WHERE date LIKE ? ORDER BY date`
  ).bind(`${year}-%`).all();
  return c.json(rows.results);
});

/** 获取某年所有见报日期 (派生: 周一至周五见报 - 显式休刊 + 显式见报) */
calendarRoutes.get('/publish-dates', async c => {
  const year = c.req.query('year') ?? new Date().getFullYear().toString();
  const holidays = await c.env.PB_DB.prepare(
    `SELECT date FROM calendar WHERE date LIKE ? AND type = 'holiday'`
  ).bind(`${year}-%`).all();
  const holidaySet = new Set(holidays.results.map((r: any) => r.date));

  const publishDates: string[] = [];
  const d = new Date(Date.UTC(Number(year), 0, 1));
  const end = new Date(Date.UTC(Number(year), 11, 31));
  while (d <= end) {
    const ds = d.toISOString().slice(0, 10);
    const w = d.getUTCDay();
    const isWeekday = w >= 1 && w <= 5;
    if (isWeekday && !holidaySet.has(ds)) publishDates.push(ds);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return c.json({ year: Number(year), publishDates, holidays: [...holidaySet] });
});

/** 获取某年所有排班周期 (见报日 + 值班日范围) */
calendarRoutes.get('/cycles', async c => {
  const year = Number(c.req.query('year') ?? new Date().getFullYear());
  const rows = await c.env.PB_DB.prepare(
    `SELECT date, type, name FROM calendar WHERE date LIKE ? ORDER BY date`
  ).bind(`${year}-%`).all<CalendarEntry>();
  const cal = new CalendarIndex(rows.results ?? []);
  const cycles = computeAllCycles(year, cal);
  return c.json({
    year,
    cycles: cycles.map(cy => ({
      publishStart: cy.start,
      publishEnd: cy.end,
      dutyStart: cal.dutyDateOf(cy.start),
      dutyEnd: cal.dutyDateOf(cy.end),
    })),
  });
});

/** 新增/更新一条日历记录 (后台维护) */
calendarRoutes.put('/', async c => {
  const { date, type, name } = await c.req.json();
  if (!date || !type) return c.json({ error: 'date, type 必填' }, 400);
  await c.env.PB_DB.prepare(
    `INSERT INTO calendar (date, type, name, source) VALUES (?, ?, ?, 'manual')
     ON CONFLICT(date) DO UPDATE SET type = excluded.type, name = excluded.name, updated_at = datetime('now')`
  ).bind(date, type, name ?? null).run();
  return c.json({ ok: true });
});

/** 批量导入 (JSON 数组) */
calendarRoutes.post('/bulk', async c => {
  const items = await c.req.json();
  const stmts = items.map((it: any) =>
    c.env.PB_DB.prepare(
      `INSERT INTO calendar (date, type, name, source) VALUES (?, ?, ?, 'manual')
       ON CONFLICT(date) DO UPDATE SET type = excluded.type, name = excluded.name, updated_at = datetime('now')`
    ).bind(it.date, it.type, it.name ?? null)
  );
  await c.env.PB_DB.batch(stmts);
  return c.json({ ok: true, count: items.length });
});
