// 排班生成器 (贪心 + 轮换)

import {
  CalendarIndex,
  weekdayName,
  isFridayOrPreHoliday,
  addDays,
} from './calendar';
import { cyclePublishDates, computeCycle } from './cycle';
import type {
  CalendarEntry,
  EngineSettings,
  ScheduleRow,
} from './types';

export interface GenerateParams {
  /** 周期内任意见报日 (用于定位周期) */
  anchorDate: string;
  entries: CalendarEntry[];
  settings: EngineSettings;
}

/**
 * 生成一个周期的排班候选。
 * 策略:
 *  1. 先锁定 "周五/节前值班日" 的一版编辑 (按 fridayRotation 轮换)。
 *     周五/节前以 **值班日** 判定 (见 isFridayOrPreHoliday)。
 *  2. 其余值班日按贪心分配一版/二版:
 *     - 优先选当前周期值班次数最少的人 (均衡)
 *     - 与上次值班的 **值班日间隔** >= minGap (硬约束, 否则不选)
 *     - 角色匹配 (一版需 first-capable, 二版需 second-capable)
 *     - 刘钊每周期 <= liuZhaoMax
 *     - 同一人同周最多 2 块版
 *     - 同时做一版/二版的人, 两类数量尽量均等
 *     - 避免同一人连续在同一星期值班 (如连续周一)
 */
export function generateSchedule(params: GenerateParams): ScheduleRow[] {
  const { anchorDate, entries, settings } = params;
  const cal = new CalendarIndex(entries);
  const cycle = computeCycle(anchorDate, cal);
  const publishDates = cyclePublishDates(cycle, cal);

  const activeMembers = settings.members.filter(
    m => m.role !== 'inactive'
  );
  const bothSet = new Set(
    activeMembers.filter(m => m.role === 'both').map(m => m.name)
  );
  const firstCapable = activeMembers.filter(
    m => m.role === 'both' || m.role === 'first_only'
  ).map(m => m.name);
  const secondCapable = activeMembers.filter(
    m => m.role === 'both' || m.role === 'second_only'
  ).map(m => m.name);

  const rotation = settings.fridayRotation.filter(n =>
    firstCapable.includes(n) || secondCapable.includes(n)
  );
  const liuZhaoMax = settings.liuZhaoMax ?? 2;
  // minGap: 两次值班之间至少间隔多少个 **值班日** (中间夹的值班日数)
  const minGap = settings.minGapDays ?? 2;
  // 均衡目标: 每人理想值班次数 (一版+二版共 publishDates*2 个槽, 均分到 active 人员)
  const ideal = Math.ceil((publishDates.length * 2) / activeMembers.length);

  // 休假排除: date|name 集合
  const excludeSet = new Set<string>();
  for (const ex of settings.exclusions) {
    for (const d of ex.dates) {
      excludeSet.add(`${d}|${ex.name}`);
    }
  }

  // 统计
  const count = new Map<string, { first: number; second: number }>();
  for (const m of activeMembers) count.set(m.name, { first: 0, second: 0 });
  // 每人所有已分配值班日 (含轮换预分配, 用于双向间隔检查)
  const personDuties = new Map<string, Set<string>>();
  // 每人最近一次值班日 (用于避免连续同一星期)
  const lastDuty = new Map<string, string>();

  // 周内次数: key = ISO周-年, value = Map<name, count>
  const weekCount = new Map<string, Map<string, number>>();

  const rows: ScheduleRow[] = [];
  const fridayFirst = new Map<string, string>(); // dutyDate -> 周五轮换编辑
  let rotIdx = 0;

  // 先处理周五/节前值班日 (以值班日判定)
  for (const pub of publishDates) {
    const duty = cal.dutyDateOf(pub);
    if (isFridayOrPreHoliday(duty, cal)) {
      const editor = rotation[rotIdx % rotation.length] ?? null;
      rotIdx++;
      if (editor) {
        fridayFirst.set(duty, editor);
        assignEditor(count, personDuties, lastDuty, weekCount, editor, 'first', duty, liuZhaoMax);
      }
    }
  }

  // 再遍历所有见报日, 填充一版/二版
  for (const pub of publishDates) {
    const duty = cal.dutyDateOf(pub);
    const wk = isoWeekKey(duty);
    if (!weekCount.has(wk)) weekCount.set(wk, new Map());
    const wc = weekCount.get(wk)!;

    const row: ScheduleRow = {
      dutyDate: duty,
      publishDate: pub,
      weekday: weekdayName(duty),
      firstEditor: null,
      secondEditor: null,
      remark: null,
    };

    // 一版 (若已被周五轮换填上)
    if (fridayFirst.has(duty)) {
      const fe = fridayFirst.get(duty)!;
      if (excludeSet.has(`${duty}|${fe}`)) {
        // 周五轮换编辑休假, 另选
        row.firstEditor = pickEditor({
          candidates: firstCapable,
          count, personDuties, lastDuty, wc, duty,
          minGap, liuZhaoMax, ideal, role: 'first',
          cal, bothSet, weekday: row.weekday,
          exclude: firstCapable.filter(n => excludeSet.has(`${duty}|${n}`)),
        });
      } else {
        row.firstEditor = fe;
      }
      if (row.firstEditor) {
        assignEditor(count, personDuties, lastDuty, weekCount, row.firstEditor, 'first', duty, liuZhaoMax);
      }
    } else {
      row.firstEditor = pickEditor({
        candidates: firstCapable,
        count, personDuties, lastDuty, wc, duty,
        minGap, liuZhaoMax, ideal, role: 'first',
        cal, bothSet, weekday: row.weekday,
        exclude: firstCapable.filter(n => excludeSet.has(`${duty}|${n}`)),
      });
      if (row.firstEditor) {
        assignEditor(count, personDuties, lastDuty, weekCount, row.firstEditor, 'first', duty, liuZhaoMax);
      }
    }

    row.secondEditor = pickEditor({
      candidates: secondCapable,
      count, personDuties, lastDuty, wc, duty,
      minGap, liuZhaoMax, ideal, role: 'second',
      cal, bothSet, weekday: row.weekday,
      exclude: secondCapable.filter(n => excludeSet.has(`${duty}|${n}`))
        .concat(row.firstEditor ? [row.firstEditor] : []),
    });
    if (row.secondEditor) {
      assignEditor(count, personDuties, lastDuty, weekCount, row.secondEditor, 'second', duty, liuZhaoMax);
    }

    rows.push(row);
  }

  return rows.sort((a, b) => (a.dutyDate < b.dutyDate ? -1 : 1));
}
function pickEditor(args: {
  candidates: string[];
  count: Map<string, { first: number; second: number }>;
  personDuties: Map<string, Set<string>>;
  lastDuty: Map<string, string>;
  wc: Map<string, number>;
  duty: string;
  minGap: number;
  ideal: number;
  liuZhaoMax: number;
  role: 'first' | 'second';
  exclude: string[];
  cal: CalendarIndex;
  bothSet: Set<string>;
  weekday: string;
}): string | null {
  // 刘钊硬上限永不放宽; 其余约束分级放宽以尽量均衡且不留空槽
  const info = args.candidates
    .filter(n => !args.exclude.includes(n))
    .filter(n => !(n === '刘钊' && (args.count.get(n)!.first + args.count.get(n)!.second) >= args.liuZhaoMax))
    .map(n => {
      const c = args.count.get(n)!;
      const total = c.first + c.second;
      const quota = n === '刘钊' ? args.liuZhaoMax : args.ideal;
      const weekOk = n === '刘钊' ? (args.wc.get(n) ?? 0) < 1 : (args.wc.get(n) ?? 0) < 2;
      const quotaOk = total < quota;
      // 间隔: 与所有已分配值班日的最近距离 (双向)
      const duties = args.personDuties.get(n);
      let nearest = Infinity;
      let dutyOk = true;
      if (duties) {
        for (const d of duties) {
          if (d === args.duty) { dutyOk = false; break; }
          const [lo, hi] = d < args.duty ? [d, args.duty] : [args.duty, d];
          const gap = args.cal.publishDatesBetween(addDays(lo, 1), addDays(hi, -1)).length;
          if (gap < nearest) nearest = gap;
        }
        if (nearest < args.minGap) dutyOk = false;
      }
      // 一版/二版数量均衡 (仅 both 编辑)
      let imbalance = 0;
      if (args.bothSet.has(n)) {
        const afterFirst = args.role === 'first' ? c.first + 1 : c.first;
        const afterSecond = args.role === 'second' ? c.second + 1 : c.second;
        imbalance = Math.abs(afterFirst - afterSecond);
      }
      // 连续同一星期值班惩罚
      const last = args.lastDuty.get(n);
      const sameWeekday = last ? weekdayName(last) === args.weekday : false;
      return { n, total, weekOk, quotaOk, dutyOk, nearest, imbalance, sameWeekday, _rnd: Math.random() };
    });
  // 分级: 全满足 → 放宽配额 → 放宽间隔 → 放宽周内 → 刘钊仍守周上限 → 兜底
  const levels: ((f: typeof info[number]) => boolean)[] = [
    f => f.weekOk && f.quotaOk && f.dutyOk,
    f => f.weekOk && f.dutyOk,
    f => f.weekOk && f.quotaOk,
    f => f.weekOk,
    f => f.n !== '刘钊' || f.weekOk,
    () => true,
  ];
  for (const pred of levels) {
    const pool = info.filter(pred);
    if (pool.length) {
      pool.sort((a, b) =>
        a.total - b.total ||
        (a.sameWeekday ? 1 : 0) - (b.sameWeekday ? 1 : 0) ||
        a.imbalance - b.imbalance ||
        b.nearest - a.nearest ||
        a._rnd - b._rnd
      );
      return pool[0].n;
    }
  }
  return null;
}
function assignEditor(
  count: Map<string, { first: number; second: number }>,
  personDuties: Map<string, Set<string>>,
  lastDuty: Map<string, string>,
  weekCount: Map<string, Map<string, number>>,
  name: string,
  role: 'first' | 'second',
  duty: string,
  _liuZhaoMax: number
) {
  const c = count.get(name);
  if (c) {
    if (role === 'first') c.first++;
    else c.second++;
  }
  let ds = personDuties.get(name);
  if (!ds) { ds = new Set(); personDuties.set(name, ds); }
  ds.add(duty);
  lastDuty.set(name, duty);
  const wk = isoWeekKey(duty);
  if (!weekCount.has(wk)) weekCount.set(wk, new Map());
  const wc = weekCount.get(wk)!;
  wc.set(name, (wc.get(name) ?? 0) + 1);
}

function isoWeekKey(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const week1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7
  );
  return `${d.getUTCFullYear()}-W${week}`;
}
