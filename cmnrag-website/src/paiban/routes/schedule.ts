// 排班表 CRUD + 生成路由 (全局共享, 不按用户隔离)

import { Hono } from 'hono';
import type { Env } from '../index';
import {
  CalendarIndex,
  addDays,
  generateSchedule,
  computeStats,
  isFridayOrPreHoliday,
  type CalendarEntry,
  type EngineSettings,
  type ScheduleRow,
} from '../engine';

/** D1 schedules 表行 (snake_case) */
interface ScheduleDBRow {
  id: number;
  user_id: number;
  duty_date: string;
  publish_date: string;
  weekday: string;
  first_editor: string | null;
  second_editor: string | null;
  remark: string | null;
  locked_first: number;
  locked_second: number;
}

/** D1 行 → 引擎 ScheduleRow (camelCase), 供 computeStats 使用 */
function toScheduleRow(r: ScheduleDBRow): ScheduleRow {
  return {
    id: r.id,
    dutyDate: r.duty_date,
    publishDate: r.publish_date,
    weekday: r.weekday,
    firstEditor: r.first_editor,
    secondEditor: r.second_editor,
    remark: r.remark,
  };
}

/** 全局共享 user_id (所有登录用户看到同一份排班) */
const GLOBAL_USER_ID = 1;

export const scheduleRoutes = new Hono<{ Bindings: Env }>();

// ── Helpers ──

async function loadCalendarEntries(db: D1Database, year: number): Promise<CalendarEntry[]> {
  const rows = await db.prepare(
    `SELECT date, type, name FROM calendar WHERE date LIKE ? ORDER BY date`
  ).bind(`${year}-%`).all<CalendarEntry>();
  return rows.results ?? [];
}

async function loadSettings(db: D1Database): Promise<EngineSettings> {
  const row = await db.prepare('SELECT * FROM settings WHERE id = 1').first<{
    members_json: string;
    friday_rotation_json: string;
    exclusions_json: string | null;
  }>();
  if (!row) return { members: [], fridayRotation: [], exclusions: [] };
  return {
    members: JSON.parse(row.members_json),
    fridayRotation: JSON.parse(row.friday_rotation_json),
    exclusions: JSON.parse(row.exclusions_json ?? '[]'),
  };
}

/** 与引擎一致的轮换名单 (过滤掉非值班人员) */
function rotationList(settings: EngineSettings): string[] {
  const active = settings.members.filter(m => m.role !== 'inactive');
  const capable = new Set(
    active
      .filter(m => m.role === 'both' || m.role === 'first_only' || m.role === 'second_only')
      .map(m => m.name)
  );
  return settings.fridayRotation.filter(n => capable.has(n));
}

/**
 * 计算周五/节前轮换起点: 从历史排班中找到 duty_start 之前最近一个轮换值班日,
 * 以其一版编辑在 rotation 中的位置 +1 作为下一周期轮换起点 (保证接续历史)。
 * 若历史中无匹配 (未排过 / 人工填了非轮换名单的人), 回退到 0。
 */
async function computeFridayRotationStart(
  db: D1Database,
  dutyStart: string,
  rotation: string[],
  cal: CalendarIndex
): Promise<number> {
  if (rotation.length === 0) return 0;
  const recent = await db.prepare(
    `SELECT duty_date, first_editor FROM schedules
     WHERE user_id = ? AND duty_date < ? AND first_editor IS NOT NULL AND first_editor <> ''
     ORDER BY duty_date DESC LIMIT 120`
  ).bind(GLOBAL_USER_ID, dutyStart).all<{ duty_date: string; first_editor: string }>();
  for (const r of recent.results) {
    // 只认轮换日 (周五/节前值班日), 非轮换日的编辑不消耗轮换指针
    if (!isFridayOrPreHoliday(r.duty_date, cal)) continue;
    const idx = rotation.indexOf(r.first_editor);
    if (idx >= 0) return (idx + 1) % rotation.length;
  }
  return 0;
}


// ── CRUD ──

/** 列出全局排班 (按值班日期升序) */
scheduleRoutes.get('/', async c => {
  const startDate = c.req.query('start');
  const endDate = c.req.query('end');
  let stmt;
  if (startDate && endDate) {
    stmt = c.env.PB_DB.prepare(
      `SELECT * FROM schedules WHERE user_id = ? AND duty_date BETWEEN ? AND ? ORDER BY duty_date`
    ).bind(GLOBAL_USER_ID, startDate, endDate);
  } else {
    stmt = c.env.PB_DB.prepare(
      `SELECT * FROM schedules WHERE user_id = ? ORDER BY duty_date`
    ).bind(GLOBAL_USER_ID);
  }
  const dbRows = await stmt.all<ScheduleDBRow>();
  const stats = computeStats(dbRows.results.map(toScheduleRow));
  return c.json({ rows: dbRows.results, stats });
});

/** 新增一行 */
scheduleRoutes.post('/', async c => {
  const body = await c.req.json();
  const r = await c.env.PB_DB.prepare(
    `INSERT INTO schedules (user_id, duty_date, publish_date, weekday, first_editor, second_editor, remark)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    GLOBAL_USER_ID, body.dutyDate, body.publishDate, body.weekday,
    body.firstEditor ?? null, body.secondEditor ?? null, body.remark ?? null
  ).run();
  return c.json({ ok: true, id: r.meta.last_row_id });
});

/** 更新一行 */
scheduleRoutes.put('/:id', async c => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json();
  await c.env.PB_DB.prepare(
    `UPDATE schedules SET
       duty_date = ?, publish_date = ?, weekday = ?,
       first_editor = ?, second_editor = ?, remark = ?,
       updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`
  ).bind(
    body.dutyDate, body.publishDate, body.weekday,
    body.firstEditor ?? null, body.secondEditor ?? null, body.remark ?? null,
    id, GLOBAL_USER_ID
  ).run();
  return c.json({ ok: true });
});

/** 删除一行 */
scheduleRoutes.delete('/:id', async c => {
  const id = Number(c.req.param('id'));
  await c.env.PB_DB.prepare(
    `DELETE FROM schedules WHERE id = ? AND user_id = ?`
  ).bind(id, GLOBAL_USER_ID).run();
  return c.json({ ok: true });
});

/** 清空指定日期范围内的排班 (只保留锁定的格子: 锁定侧编辑值+锁定标记, 其余全部清空) */
scheduleRoutes.delete('/range/:start/:end', async c => {
  const start = c.req.param('start');
  const end = c.req.param('end');
  const locked = await c.env.PB_DB.prepare(
    `SELECT duty_date, publish_date, weekday, first_editor, second_editor, locked_first, locked_second
     FROM schedules WHERE user_id = ? AND duty_date >= ? AND duty_date <= ?
       AND (locked_first = 1 OR locked_second = 1)`
  ).bind(GLOBAL_USER_ID, start, end).all<{
    duty_date: string; publish_date: string; weekday: string;
    first_editor: string | null; second_editor: string | null;
    locked_first: number; locked_second: number;
  }>();
  const stmts: D1PreparedStatement[] = [
    c.env.PB_DB.prepare(
      `DELETE FROM schedules WHERE user_id = ? AND duty_date >= ? AND duty_date <= ?`
    ).bind(GLOBAL_USER_ID, start, end),
  ];
  for (const r of locked.results) {
    stmts.push(
      c.env.PB_DB.prepare(
        `INSERT INTO schedules (user_id, duty_date, publish_date, weekday, first_editor, second_editor, remark, locked_first, locked_second)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      ).bind(
        GLOBAL_USER_ID, r.duty_date, r.publish_date, r.weekday,
        r.locked_first === 1 ? r.first_editor : null,
        r.locked_second === 1 ? r.second_editor : null,
        r.locked_first, r.locked_second
      )
    );
  }
  await c.env.PB_DB.batch(stmts);
  return c.json({ ok: true, keptLockedCells: locked.results.length });
});

/** 锁定/解锁一行 (一版/二版格子可分别锁定, 也可同时) */
scheduleRoutes.put('/:id/lock', async c => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ first?: boolean; second?: boolean }>();
  const set: string[] = [];
  const params: (number | string)[] = [];
  if (body.first !== undefined) { set.push('locked_first = ?'); params.push(body.first ? 1 : 0); }
  if (body.second !== undefined) { set.push('locked_second = ?'); params.push(body.second ? 1 : 0); }
  if (set.length === 0) return c.json({ error: 'first/second 至少传一个' }, 400);
  params.push(id, GLOBAL_USER_ID);
  await c.env.PB_DB.prepare(
    `UPDATE schedules SET ${set.join(', ')}, updated_at = datetime('now') WHERE id = ? AND user_id = ?`
  ).bind(...params).run();
  return c.json({ ok: true });
});

/** 读取范围内已锁定的格子 + 需保留的整行数据 (用于生成/批量替换时保留) */
async function loadLockedState(
  db: D1Database,
  start: string,
  end: string
): Promise<{
  lockedCells: Map<string, { first?: string; second?: string }>;
  preserved: Map<string, { publish_date: string; weekday: string; first_editor: string | null; second_editor: string | null; remark: string | null }>;
}> {
  const rows = await db.prepare(
    `SELECT duty_date, publish_date, weekday, first_editor, second_editor, remark, locked_first, locked_second
     FROM schedules WHERE user_id = ? AND duty_date BETWEEN ? AND ?`
  ).bind(GLOBAL_USER_ID, start, end).all<{
    duty_date: string; publish_date: string; weekday: string;
    first_editor: string | null; second_editor: string | null; remark: string | null;
    locked_first: number; locked_second: number;
  }>();
  const lockedCells = new Map<string, { first?: string; second?: string }>();
  const preserved = new Map<string, { publish_date: string; weekday: string; first_editor: string | null; second_editor: string | null; remark: string | null }>();
  for (const r of rows.results) {
    if (r.locked_first !== 1 && r.locked_second !== 1) continue;
    preserved.set(r.duty_date, {
      publish_date: r.publish_date, weekday: r.weekday,
      first_editor: r.first_editor, second_editor: r.second_editor, remark: r.remark,
    });
    const cell: { first?: string; second?: string } = {};
    if (r.locked_first === 1 && r.first_editor) cell.first = r.first_editor;
    if (r.locked_second === 1 && r.second_editor) cell.second = r.second_editor;
    lockedCells.set(r.duty_date, cell);
  }
  return { lockedCells, preserved };
}

/** 批量替换 (用于生成后整体写入; 保留锁定格, 未锁定格用传入 rows 覆盖) */
scheduleRoutes.post('/bulk', async c => {
  const { rows, startDate, endDate } = await c.req.json<{
    rows: ScheduleRow[]; startDate: string; endDate: string;
  }>();
  const { lockedCells, preserved } = await loadLockedState(c.env.PB_DB, startDate, endDate);

  // 合并: 传入 rows 为主, 锁定格/锁定行数据覆盖回去
  const merged = new Map<string, ScheduleRow>();
  for (const r of rows) merged.set(r.dutyDate, r);
  for (const [duty, r] of merged) {
    const cell = lockedCells.get(duty);
    const p = preserved.get(duty);
    if (cell) {
      if (cell.first) r.firstEditor = cell.first;
      if (cell.second) r.secondEditor = cell.second;
    }
    if (p) r.remark = p.remark ?? r.remark;
  }
  // 范围内有锁定但不在传入 rows 中的行 (如周末/休刊手填行) 也保留
  for (const [duty, p] of preserved) {
    if (!merged.has(duty)) {
      merged.set(duty, {
        dutyDate: duty, publishDate: p.publish_date, weekday: p.weekday,
        firstEditor: p.first_editor, secondEditor: p.second_editor, remark: p.remark,
      });
    }
  }

  const stmts: D1PreparedStatement[] = [
    c.env.PB_DB.prepare(
      `DELETE FROM schedules WHERE user_id = ? AND duty_date BETWEEN ? AND ?`
    ).bind(GLOBAL_USER_ID, startDate, endDate),
  ];
  for (const r of [...merged.values()].sort((a, b) => (a.dutyDate < b.dutyDate ? -1 : 1))) {
    const cell = lockedCells.get(r.dutyDate);
    stmts.push(
      c.env.PB_DB.prepare(
        `INSERT INTO schedules (user_id, duty_date, publish_date, weekday, first_editor, second_editor, remark, locked_first, locked_second)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        GLOBAL_USER_ID, r.dutyDate, r.publishDate, r.weekday,
        r.firstEditor ?? null, r.secondEditor ?? null, r.remark ?? null,
        cell?.first ? 1 : 0, cell?.second ? 1 : 0
      )
    );
  }
  await c.env.PB_DB.batch(stmts);
  const result = await c.env.PB_DB.prepare(
    `SELECT * FROM schedules WHERE user_id = ? AND duty_date BETWEEN ? AND ? ORDER BY duty_date`
  ).bind(GLOBAL_USER_ID, startDate, endDate).all<ScheduleDBRow>();
  const stats = computeStats(result.results.map(toScheduleRow));
  return c.json({ ok: true, rows: result.results, stats, skippedLocked: lockedCells.size });
});

// ── 生成 ──
/**
 * 生成本周期排班。
 * Body: { start: string, end: string, specialRules?: string }
 * start/end 为值班日期范围 (已由前端从见报日期转换)
 */
scheduleRoutes.post('/generate', async c => {
  const { start, end } = await c.req.json<{
    start: string; end: string;
  }>();

  if (!start || !end) {
    return c.json({ error: '请先选择排班周期' }, 400);
  }

  const year = new Date(start + 'T00:00:00Z').getUTCFullYear();
  const entries = await loadCalendarEntries(c.env.PB_DB, year);
  const cal = new CalendarIndex(entries);
  const settings = await loadSettings(c.env.PB_DB);

  // 锚点 = 值班日的下一个见报日 (节假日/周末时值班日与见报日相隔多天, 不能用 +1 近似)
  let anchorDate = addDays(start, 1);
  for (let i = 0; i < 30 && !cal.isPublish(anchorDate); i++) anchorDate = addDays(anchorDate, 1);
  // 轮换接续: 起点 = 历史最近一个周五轮换位的下一人 (否则每次从 rotation[0] 重新开始)
  const rotation = rotationList(settings);
  const fridayRotationStart = await computeFridayRotationStart(c.env.PB_DB, start, rotation, cal);
  // 锁定格子: 已锁定的编辑计入均衡统计并在生成结果中保留
  const { lockedCells, preserved } = await loadLockedState(c.env.PB_DB, start, end);
  const rows = generateSchedule({ anchorDate, entries, settings, fridayRotationStart, lockedCells });

  // 只保留周期范围内的行
  const filteredRows = rows.filter(r => r.dutyDate >= start && r.dutyDate <= end);

  // 合并: 生成结果为主, 锁定行/锁定格数据覆盖回去 (含备注与周末手填行)
  const merged = new Map<string, ScheduleRow>();
  for (const r of filteredRows) merged.set(r.dutyDate, r);
  for (const [duty, r] of merged) {
    const cell = lockedCells.get(duty);
    const p = preserved.get(duty);
    if (cell) {
      if (cell.first) r.firstEditor = cell.first;
      if (cell.second) r.secondEditor = cell.second;
    }
    if (p) r.remark = p.remark ?? r.remark;
  }
  for (const [duty, p] of preserved) {
    if (!merged.has(duty)) {
      merged.set(duty, {
        dutyDate: duty, publishDate: p.publish_date, weekday: p.weekday,
        firstEditor: p.first_editor, secondEditor: p.second_editor, remark: p.remark,
      });
    }
  }

  // 删除范围内所有行, 重新写入合并结果 (锁定标记随格子保留)
  const stmts: D1PreparedStatement[] = [
    c.env.PB_DB.prepare(
      `DELETE FROM schedules WHERE user_id = ? AND duty_date BETWEEN ? AND ?`
    ).bind(GLOBAL_USER_ID, start, end),
  ];
  for (const r of [...merged.values()].sort((a, b) => (a.dutyDate < b.dutyDate ? -1 : 1))) {
    const cell = lockedCells.get(r.dutyDate);
    stmts.push(
      c.env.PB_DB.prepare(
        `INSERT INTO schedules (user_id, duty_date, publish_date, weekday, first_editor, second_editor, remark, locked_first, locked_second)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        GLOBAL_USER_ID, r.dutyDate, r.publishDate, r.weekday,
        r.firstEditor ?? null, r.secondEditor ?? null, r.remark ?? null,
        cell?.first ? 1 : 0, cell?.second ? 1 : 0
      )
    );
  }
  await c.env.PB_DB.batch(stmts);

  // 返回完整周期数据 (含锁定的)
  const result = await c.env.PB_DB.prepare(
    `SELECT * FROM schedules WHERE user_id = ? AND duty_date BETWEEN ? AND ? ORDER BY duty_date`
  ).bind(GLOBAL_USER_ID, start, end).all<ScheduleDBRow>();
  const allRows = result.results.map(toScheduleRow);
  const stats = computeStats(allRows);
  return c.json({
    ok: true,
    cycle: { start, end },
    rows: allRows,
    stats,
    skippedLocked: lockedCells.size,
  });
});
