// 排班周期划分

import { CalendarIndex, addDays, dayOfWeek } from './calendar';
import type { CalendarEntry } from './types';

/**
 * 排班周期定义:
 *   从某月第一个 "16日或更晚的见报日期" 开始,
 *   到下个月 "最接近15日的见报日期" 为止。
 *
 * 给定一个日期 (通常为周期内的任意见报日), 返回该周期的起止见报日。
 */
export function computeCycle(
  anyDate: string,
  cal: CalendarIndex
): { start: string; end: string } {
  const d = new Date(anyDate + 'T00:00:00');
  const year = d.getFullYear();
  const month = d.getMonth(); // 0-indexed

  // 周期开始: 本月 16 日或更晚的第一个见报日
  const start = firstPublishOnOrAfter(year, month, 16, cal);

  // 若 anyDate 早于本月周期起点, 则它实际属于上月周期
  // (例如 1 月初的见报日属于 12-1 月周期, 而非 1-2 月周期)
  if (anyDate < start) {
    const pm = month - 1 < 0 ? 11 : month - 1;
    const py = month - 1 < 0 ? year - 1 : year;
    const prevStart = firstPublishOnOrAfter(py, pm, 16, cal);
    const end = publishClosestTo(year, month, 15, cal);
    return { start: prevStart, end };
  }

  // 周期结束: 下个月最接近 15 日的见报日
  const end = publishClosestTo(year, month + 1, 15, cal);

  return { start, end };
}

/**
 * 列出给定周期内的所有见报日期 (升序)。
 */
export function cyclePublishDates(
  cycle: { start: string; end: string },
  cal: CalendarIndex
): string[] {
  return cal.publishDatesBetween(cycle.start, cycle.end);
}

/**
 * 列出某年所有排班周期 (逐月: 本月首个 ≥16 见报日 ~ 下月最接近15见报日)。
 * 跳过起点超过年末的月份。
 */
export function computeAllCycles(
  year: number,
  cal: CalendarIndex
): { start: string; end: string }[] {
  const cycles: { start: string; end: string }[] = [];
  for (let month0 = 0; month0 < 12; month0++) {
    const start = firstPublishOnOrAfter(year, month0, 16, cal);
    if (start > `${year}-12-31`) break;
    const end = publishClosestTo(year, month0 + 1, 15, cal);
    cycles.push({ start, end });
  }
  return cycles;
}

/** 从 year-month-day 起第一个 >= day 的见报日 */
function firstPublishOnOrAfter(
  year: number,
  month: number,
  day: number,
  cal: CalendarIndex
): string {
  // 处理月份溢出
  const y = month > 11 ? year + 1 : year;
  const m = month > 11 ? 0 : month;
  let cur = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  for (let i = 0; i < 20; i++) {
    if (cal.isPublish(cur)) return cur;
    cur = addDays(cur, 1);
  }
  return cur;
}

/** year-month 中最接近 day 的见报日 (向前后搜索) */
function publishClosestTo(
  year: number,
  month: number,
  day: number,
  cal: CalendarIndex
): string {
  const y = month > 11 ? year + 1 : year;
  const m = month > 11 ? 0 : month;
  const target = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  // 优先返回不超过 target 的最近见报日 (周期"止"的语义); 若没有则取之后最近的
  for (let offset = 0; offset <= 15; offset++) {
    const before = addDays(target, -offset);
    if (cal.isPublish(before) && dayOfWeek(before) <= 5) return before;
  }
  for (let offset = 1; offset <= 15; offset++) {
    const after = addDays(target, offset);
    if (cal.isPublish(after) && dayOfWeek(after) <= 5) return after;
  }
  return target;
}

/** 从 CalendarEntry[] 构造周期 (便利函数) */
export function cycleFromEntries(
  anyDate: string,
  entries: CalendarEntry[]
): { start: string; end: string } {
  return computeCycle(anyDate, new CalendarIndex(entries));
}
