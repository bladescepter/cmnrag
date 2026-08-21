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
  /** 周五/节前轮换起点 (索引), 默认 0。
   *  生成新周期时应传入历史最后一位周五编辑的下一位置, 保证轮换接续,
   *  否则每次生成都会从 fridayRotation[0] 重新开始。 */
  fridayRotationStart?: number;
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

  const fridayFirst = new Map<string, string>(); // dutyDate -> 周五轮换编辑
  let rotIdx = params.fridayRotationStart ?? 0;

  // 先处理周五/节前值班日 (以值班日判定)
  // 仅记录轮换位, 不在此处 assignEditor (避免与主循环重复计数)
  for (const pub of publishDates) {
    const duty = cal.dutyDateOf(pub);
    if (isFridayOrPreHoliday(duty, cal)) {
      const editor = rotation[rotIdx % rotation.length] ?? null;
      rotIdx++;
      if (editor) fridayFirst.set(duty, editor);
    }
  }

  // 两阶段分配: 先全部分配一版, 再全部分配二版。
  // 这样二版分配能看到完整的一版结果, 对"一版少的人"优先补二版,
  // 避免逐行交替分配时一版/二版互相干扰造成的两极分化。
  const rows: ScheduleRow[] = publishDates.map(pub => ({
    dutyDate: cal.dutyDateOf(pub),
    publishDate: pub,
    weekday: weekdayName(cal.dutyDateOf(pub)),
    firstEditor: null,
    secondEditor: null,
    remark: null,
  }));

  // 单角色人员 (first_only 等) 名额预约: 若其轮换位在周期后半,
  // 则贪心名额会自然落到周期末尾与轮换位撞车 (如刘钊 10-08 + 10-09 连续)。
  // 故将贪心名额预约到前 1/3 末的非轮换日, 使两个名额分散 (一前一后)。
  // 轮换位在前半时无需预约 (贪心名额自然靠后)。
  const reserveByDuty = new Map<string, string>(); // duty -> name
  for (const n of firstCapable.filter(nm => !bothSet.has(nm))) {
    let rotPos = -1;
    for (let i = 0; i < rows.length; i++) {
      if (fridayFirst.get(rows[i].dutyDate) === n) { rotPos = i; break; }
    }
    if (rotPos < 0 || rotPos < rows.length / 2) continue; // 无轮换位或轮换位在前半 → 不预约 (贪心名额自然靠后)
    // 轮换位在后半: 从后往前找前 1/3 末的非轮换、非休假日预约
    const limit = Math.min(Math.floor(rows.length / 3), rows.length - 1);
    for (let i = limit; i >= 0; i--) {
      const d = rows[i].dutyDate;
      if (!fridayFirst.has(d) && !excludeSet.has(`${d}|${n}`)) { reserveByDuty.set(d, n); break; }
    }
  }

  // 阶段 1: 一版
  for (const row of rows) {
    const duty = row.dutyDate;
    const wk = isoWeekKey(duty);
    if (!weekCount.has(wk)) weekCount.set(wk, new Map());
    const wc = weekCount.get(wk)!;

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
    } else {
      // 单角色名额预约: 若本日被预约且预约人尚未被贪心选中, 优先给预约人
      const reserved = reserveByDuty.get(duty);
      if (reserved && (count.get(reserved)?.first ?? 0) === 0) {
        row.firstEditor = reserved;
      } else {
        row.firstEditor = pickEditor({
          candidates: firstCapable,
          count, personDuties, lastDuty, wc, duty,
          minGap, liuZhaoMax, ideal, role: 'first',
          cal, bothSet, weekday: row.weekday,
          exclude: firstCapable.filter(n => excludeSet.has(`${duty}|${n}`)),
        });
      }
    }
    if (row.firstEditor) {
      assignEditor(count, personDuties, lastDuty, weekCount, row.firstEditor, 'first', duty, liuZhaoMax);
    }
  }

  // 阶段 2: 二版 (能看到完整一版结果)
  for (const row of rows) {
    const duty = row.dutyDate;
    const wk = isoWeekKey(duty);
    if (!weekCount.has(wk)) weekCount.set(wk, new Map());
    const wc = weekCount.get(wk)!;

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
  }

  return rows;
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
  // 刘钊为硬约束: 每周期 ≤ liuZhaoMax、每周 ≤ 1 版, 在候选过滤阶段即排除,
  // 任何放宽阶段均不放宽。
  // 其余人员 (含史光浩等单角色) 不设硬上限: 均衡靠排序主键 (总版数最少优先)
  // + 分级放宽自然达成, 配额 (ideal) 仅是软偏好, 人手紧时允许超配。
  const info = args.candidates
    .filter(n => !args.exclude.includes(n))
    .filter(n => n !== '刘钊' || (
      (args.count.get(n)!.first + args.count.get(n)!.second) < args.liuZhaoMax &&
      (args.wc.get(n) ?? 0) < 1
    ))
    .map((n, seedIdx) => {
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
      // 单角色人员 (first_only/second_only) 不参与: 设 +Infinity 使其同 total 时排在 both 之后,
      // 避免其因 imbalance 恒为 0 而在周期开头被优先选中 (如刘钊第一天就占满名额),
      // 让单角色名额自然落到周期中后段, 与轮换位名额时间上分散。
      let imbalance = Number.POSITIVE_INFINITY;
      if (args.bothSet.has(n)) {
        const afterFirst = args.role === 'first' ? c.first + 1 : c.first;
        const afterSecond = args.role === 'second' ? c.second + 1 : c.second;
        imbalance = Math.abs(afterFirst - afterSecond);
      }
      // 连续同一星期值班惩罚
      const last = args.lastDuty.get(n);
      const sameWeekday = last ? weekdayName(last) === args.weekday : false;
      return { n, total, weekOk, quotaOk, dutyOk, nearest, imbalance, sameWeekday, first: c.first, second: c.second, seedIdx };
    });
  // 软约束分级 (刘钊已在候选过滤中被硬约束, 超限者不在 info 中):
  // 全满足 → 放宽间隔(保持配额) → 放宽配额(保持间隔) → 全放宽 → 兜底
  // 注意: 配额(均衡)优先级高于间隔, 尽量让每人不超过理想配额
  const levels: ((f: typeof info[number]) => boolean)[] = [
    f => f.weekOk && f.quotaOk && f.dutyOk,
    f => f.weekOk && f.quotaOk,
    f => f.weekOk && f.dutyOk,
    f => f.weekOk,
    () => true,
  ];
  for (const pred of levels) {
    const pool = info.filter(pred);
    if (pool.length) {
      // 确定性排序 (无随机):
      //  1. 总版数最少 (均衡主键)
      //  2. 一/二版差更小者优先 (避免纯一版或纯二版)
      //  3. 避免连续同星期 → 4. 名单顺序
      // 注意: 不用 first/second 或 nearest 做 tie-break —— 前者会制造
      // "一版少的人垄断二版"的马太效应, 后者会因间隔最大化把版数推给少数人;
      // 间隔已由 dutyOk(minGap) 硬约束保证。
      pool.sort((a, b) =>
        a.total - b.total ||
        a.imbalance - b.imbalance ||
        (a.sameWeekday ? 1 : 0) - (b.sameWeekday ? 1 : 0) ||
        a.seedIdx - b.seedIdx
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
