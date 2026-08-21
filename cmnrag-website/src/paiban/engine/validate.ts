// 排班校验 + 统计

import {
  CalendarIndex,
  addDays,
  isFridayOrPreHoliday,
} from './calendar';
import { cyclePublishDates, computeCycle } from './cycle';
import type {
  CalendarEntry,
  EngineSettings,
  PeriodStats,
  ScheduleRow,
  ValidationResult,
  Violation,
} from './types';

/**
 * 校验一组排班是否满足硬/软规则。
 */
export function validateSchedule(
  rows: ScheduleRow[],
  settings: EngineSettings,
  entries: CalendarEntry[]
): ValidationResult {
  const cal = new CalendarIndex(entries);
  const violations: Violation[] = [];
  const inactive = new Set(
    settings.members.filter(m => m.role === 'inactive').map(m => m.name)
  );
  const firstCapable = new Set(
    settings.members
      .filter(m => m.role === 'both' || m.role === 'first_only')
      .map(m => m.name)
  );
  const secondCapable = new Set(
    settings.members
      .filter(m => m.role === 'both' || m.role === 'second_only')
      .map(m => m.name)
  );
  const liuZhaoMax = settings.liuZhaoMax ?? 2;
  // minGap: 两次值班之间至少间隔多少个值班日 (中间夹的值班日数)
  const minGap = settings.minGapDays ?? 2;

  const count = new Map<string, number>();
  const lastDuty = new Map<string, string>();
  const weekCount = new Map<string, Map<string, number>>();

  for (const row of rows) {
    const duty = row.dutyDate;

    // 硬规则: 不参与值班的人不应出现
    for (const [field, val] of [
      ['firstEditor', row.firstEditor],
      ['secondEditor', row.secondEditor],
    ] as const) {
      const name = val;
      if (!name) continue;
      if (inactive.has(name)) {
        violations.push({
          level: 'hard',
          rule: 'inactive_assigned',
          message: `${name} 不参与值班, 不应排到 ${duty} 的${field === 'firstEditor' ? '一版' : '二版'}`,
          dutyDate: duty,
          person: name,
        });
      }
      if (field === 'firstEditor' && !firstCapable.has(name)) {
        violations.push({
          level: 'hard',
          rule: 'role_mismatch',
          message: `${name} 不能做一版 (${duty})`,
          dutyDate: duty,
          person: name,
        });
      }
      if (field === 'secondEditor' && !secondCapable.has(name)) {
        violations.push({
          level: 'hard',
          rule: 'role_mismatch',
          message: `${name} 不能做二版 (${duty})`,
          dutyDate: duty,
          person: name,
        });
      }
    }

    // 同一人同日不能同时做一版二版
    if (
      row.firstEditor &&
      row.secondEditor &&
      row.firstEditor === row.secondEditor
    ) {
      violations.push({
        level: 'hard',
        rule: 'same_person_both_versions',
        message: `${duty}: ${row.firstEditor} 同日同时做一版二版`,
        dutyDate: duty,
        person: row.firstEditor,
      });
    }

    // 统计 + 间隔 + 周内上限
    for (const [role, name] of [
      ['first', row.firstEditor],
      ['second', row.secondEditor],
    ] as const) {
      if (!name) continue;
      count.set(name, (count.get(name) ?? 0) + 1);
      // 间隔 (值班日间隔, 软规则)
      const last = lastDuty.get(name);
      if (last) {
        const [a, b] = last < duty ? [last, duty] : [duty, last];
        const gapDuties = cal.publishDatesBetween(addDays(a, 1), addDays(b, -1)).length;
        if (gapDuties < minGap) {
          violations.push({
            level: 'soft',
            rule: 'gap_too_small',
            message: `${name} 值班间隔仅 ${gapDuties} 个值班日 (${last} → ${duty})`,
            dutyDate: duty,
            person: name,
          });
        }
      }
      lastDuty.set(name, duty);

      // 周内上限
      const wk = isoWeekKey(duty);
      if (!weekCount.has(wk)) weekCount.set(wk, new Map());
      const wc = weekCount.get(wk)!;
      wc.set(name, (wc.get(name) ?? 0) + 1);
      if (wc.get(name)! > 2) {
        violations.push({
          level: 'soft',
          rule: 'too_many_per_week',
          message: `${name} 在本周值班超过 2 块 (${duty})`,
          dutyDate: duty,
          person: name,
        });
      }
    }
  }

  // 刘钊周期上限
  const lz = count.get('刘钊') ?? 0;
  if (lz > liuZhaoMax) {
    violations.push({
      level: 'hard',
      rule: 'liuzhao_max',
      message: `刘钊本周期值班 ${lz} 次, 超过上限 ${liuZhaoMax}`,
      person: '刘钊',
    });
  }

  // 周五/节前轮换顺序校验 (软)
  // 按每行所在周期计算其在周期内周五值班日序列的索引,
  // 避免 rows 跨周期或仅含部分周期数据时轮换索引错位
  const rotation = settings.fridayRotation;
  if (rotation.length) {
    const fridaySeqCache = new Map<string, string[]>();
    const fridayIndex = new Map<string, number>();
    for (const row of rows) {
      if (!isFridayOrPreHoliday(row.dutyDate, cal)) continue;
      const cycle = computeCycle(row.publishDate, cal);
      if (!fridaySeqCache.has(cycle.start)) {
        const seq = cyclePublishDates(cycle, cal)
          .map(pub => cal.dutyDateOf(pub))
          .filter(d => isFridayOrPreHoliday(d, cal));
        fridaySeqCache.set(cycle.start, seq);
        seq.forEach((d, i) => fridayIndex.set(d, i));
      }
      const idx = fridayIndex.get(row.dutyDate);
      if (idx === undefined || !row.firstEditor) continue;
      const expected = rotation[idx % rotation.length];
      if (expected && row.firstEditor !== expected) {
        violations.push({
          level: 'soft',
          rule: 'friday_rotation',
          message: `${row.dutyDate} 周五/节前应为 ${expected}, 实际 ${row.firstEditor}`,
          dutyDate: row.dutyDate,
          person: row.firstEditor,
        });
      }
    }
  }

  // 一版/二版数量均衡 (软): 仅同时做两版的编辑, 差值不应超过 1
  const bothSet = new Set(
    settings.members.filter(m => m.role === 'both').map(m => m.name)
  );
  const stats = computeStats(rows);
  for (const [name, { first, second }] of Object.entries(stats.perPerson)) {
    if (!bothSet.has(name)) continue;
    if (Math.abs(first - second) > 1) {
      violations.push({
        level: 'soft',
        rule: 'first_second_imbalance',
        message: `${name} 一版/二版数量不均: 一版 ${first}, 二版 ${second}`,
        person: name,
      });
    }
  }

  // 避免连续同一星期值班 (软)
  const personDuties = new Map<string, { duty: string; weekday: string }[]>();
  for (const row of rows) {
    for (const name of [row.firstEditor, row.secondEditor]) {
      if (!name) continue;
      if (!personDuties.has(name)) personDuties.set(name, []);
      personDuties.get(name)!.push({ duty: row.dutyDate, weekday: row.weekday });
    }
  }
  for (const [name, duties] of personDuties) {
    duties.sort((a, b) => (a.duty < b.duty ? -1 : 1));
    for (let i = 1; i < duties.length; i++) {
      if (duties[i].weekday === duties[i - 1].weekday) {
        violations.push({
          level: 'soft',
          rule: 'consecutive_same_weekday',
          message: `${name} 连续在同一星期 (${duties[i].weekday}) 值班: ${duties[i - 1].duty} → ${duties[i].duty}`,
          dutyDate: duties[i].duty,
          person: name,
        });
      }
    }
  }

  const ok = !violations.some(v => v.level === 'hard');
  return { ok, violations };
}

/** 周期统计: 每人值班次数 */
export function computeStats(rows: ScheduleRow[]): PeriodStats {
  const perPerson: Record<string, { first: number; second: number; total: number }> = {};
  let totalSlots = 0;
  for (const row of rows) {
    for (const [role, name] of [
      ['first', row.firstEditor],
      ['second', row.secondEditor],
    ] as const) {
      if (!name) continue;
      if (!perPerson[name]) perPerson[name] = { first: 0, second: 0, total: 0 };
      if (role === 'first') perPerson[name].first++;
      else perPerson[name].second++;
      perPerson[name].total++;
      totalSlots++;
    }
  }
  return { perPerson, totalSlots };
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
