// 见报日历 + 值班日期计算

import type { CalendarEntry } from './types';

/**
 * 构建见报日历的快速查找集合。
 * 约定: 若某日期在 entries 中标记为 holiday, 则休刊;
 * 否则按 "是否工作日(周一至周五)" 判断见报。
 * entries 中 type=publish 的条目可作为显式覆盖(未来用于手动指定见报)。
 */
export class CalendarIndex {
  private holidaySet = new Set<string>();
  private publishSet = new Set<string>();

  constructor(entries: CalendarEntry[]) {
    for (const e of entries) {
      if (e.type === 'holiday') this.holidaySet.add(e.date);
      else this.publishSet.add(e.date);
    }
  }

  /** 某日是否见报 */
  isPublish(date: string): boolean {
    if (this.publishSet.has(date)) return true;
    if (this.holidaySet.has(date)) return false;
    // 默认: 周一至周五见报
    return isWeekday(date);
  }

  /** 某日是否休刊(显式) */
  isHoliday(date: string): boolean {
    return this.holidaySet.has(date);
  }

  /**
   * 给定见报日期, 求其值班日期。
   * 规则: 值班日期为见报日期的上一个见报日(前一天, 遇周末/休刊则往前回溯)。
   */
  dutyDateOf(publishDate: string): string {
    let cur = addDays(publishDate, -1);
    // 安全上限: 回溯 20 天
    for (let i = 0; i < 20; i++) {
      if (this.isPublish(cur)) return cur;
      cur = addDays(cur, -1);
    }
    return cur;
  }

  /**
   * 获取从 start 到 end(含) 之间所有见报日期, 升序。
   */
  publishDatesBetween(start: string, end: string): string[] {
    const out: string[] = [];
    let cur = start;
    let guard = 0;
    while (cur <= end && guard < 400) {
      if (this.isPublish(cur)) out.push(cur);
      cur = addDays(cur, 1);
      guard++;
    }
    return out;
  }
}

/** 周一=1 .. 周日=7 */
export function dayOfWeek(date: string): number {
  const d = new Date(date + 'T00:00:00Z');
  const w = d.getUTCDay(); // 0=周日
  return w === 0 ? 7 : w;
}

export function isWeekday(date: string): boolean {
  const w = dayOfWeek(date);
  return w >= 1 && w <= 5;
}

export function weekdayName(date: string): string {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dayOfWeek(date)];
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffDays(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00Z').getTime();
  const db = new Date(b + 'T00:00:00Z').getTime();
  return Math.round((db - da) / 86400000);
}

/** 是否周五 */
export function isFriday(date: string): boolean {
  return dayOfWeek(date) === 5;
}

/**
 * 某值班日是否为 "周五值班日或节前最后一个值班日"。
 * 判定对象为 **值班日 (dutyDate)**, 而非见报日:
 *   - 值班日是周五 → true
 *   - 否则查找该值班日的下一个值班日 (= 本值班日的下一个见报日),
 *     若两者间隔 >=3 天 (跨周末或假期) → 节前最后一个值班日 → true
 *
 * 注意: 值班日序列与见报日序列一一对应 (错位一天), 给定值班日 d,
 * 它的下一个值班日恰好是 d 的下一个见报日。
 */
export function isFridayOrPreHoliday(
  dutyDate: string,
  cal: CalendarIndex
): boolean {
  if (isFriday(dutyDate)) return true;
  // 下一个值班日 = dutyDate 的下一个见报日
  let cur = addDays(dutyDate, 1);
  for (let i = 0; i < 15; i++) {
    if (cal.isPublish(cur)) {
      // 间隔 >=3 天表示跨周末/假期, 当前值班日为节前最后值班日
      return diffDays(dutyDate, cur) >= 3;
    }
    cur = addDays(cur, 1);
  }
  return false;
}
