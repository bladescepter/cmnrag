// 排班引擎周五轮换接续测试
// 回归保护: 生成周期时轮换起点必须接续历史排班, 不能每次从 rotation[0] 重新开始
import { describe, it, expect } from 'vitest';
import { generateSchedule } from '../src/paiban/engine/generate';
import { CalendarIndex } from '../src/paiban/engine/calendar';
import type { CalendarEntry, EngineSettings } from '../src/paiban/engine/types';

const HOLIDAYS = [
  '2026-01-02', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23',
  '2026-04-06', '2026-05-01', '2026-05-04', '2026-05-05', '2026-06-19',
  '2026-09-25', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
];

const entries: CalendarEntry[] = HOLIDAYS.map(d => ({ date: d, type: 'holiday', name: '休刊' }));

const settings: EngineSettings = {
  members: [
    { name: '黄彬', role: 'both' }, { name: '刘钊', role: 'first_only' }, { name: '文科', role: 'both' },
    { name: '王亮', role: 'inactive' }, { name: '赵宁', role: 'both' }, { name: '叶奕宏', role: 'both' },
    { name: '吴彤', role: 'both' }, { name: '刘丹', role: 'inactive' }, { name: '史光浩', role: 'second_only' },
    { name: '张宏伟', role: 'both' }, { name: '王畅', role: 'both' }, { name: '李悦', role: 'both' }, { name: '郭笑羽', role: 'both' },
  ],
  fridayRotation: ['黄彬', '吴彤', '叶奕宏', '文科', '李悦', '张宏伟', '赵宁', '王畅', '刘钊', '郭笑羽'],
  exclusions: [],
};

describe('周五轮换接续', () => {
  const cal = new CalendarIndex(entries);

  it('fridayRotationStart 缺失时从 rotation[0] 开始 (历史行为)', () => {
    const rows = generateSchedule({ anchorDate: '2026-09-20', entries, settings });
    const f918 = rows.find(r => r.dutyDate === '2026-09-18');
    // 未接续: 起点 = 黄彬
    expect(f918?.firstEditor).toBe('黄彬');
  });

  it('接续历史: 上一周五为李悦, 9-18 一版应为张宏伟', () => {
    // 历史: 9-11 周五 一版 = 李悦 → 起点 = 李悦后一位 = 张宏伟
    const startIdx = (settings.fridayRotation.indexOf('李悦') + 1) % settings.fridayRotation.length;
    expect(settings.fridayRotation[startIdx]).toBe('张宏伟');
    const rows = generateSchedule({ anchorDate: '2026-09-20', entries, settings, fridayRotationStart: startIdx });
    const f918 = rows.find(r => r.dutyDate === '2026-09-18');
    expect(f918?.firstEditor).toBe('张宏伟');
  });

  it('轮换位顺序正确: 9-18 张宏伟 → 9-24 赵宁(中秋前) → 9-30 王畅(国庆前) → 10-09 刘钊', () => {
    const startIdx = (settings.fridayRotation.indexOf('李悦') + 1) % settings.fridayRotation.length;
    const rows = generateSchedule({ anchorDate: '2026-09-20', entries, settings, fridayRotationStart: startIdx });
    const byDate = (d: string) => rows.find(r => r.dutyDate === d);
    expect(byDate('2026-09-18')?.firstEditor).toBe('张宏伟');
    expect(byDate('2026-09-24')?.firstEditor).toBe('赵宁');
    expect(byDate('2026-09-30')?.firstEditor).toBe('王畅');
    expect(byDate('2026-10-09')?.firstEditor).toBe('刘钊');
  });

  it('休刊日不生成值班行 (9-25 中秋, 10-02 国庆)', () => {
    const rows = generateSchedule({ anchorDate: '2026-09-20', entries, settings, fridayRotationStart: 0 });
    expect(rows.some(r => r.dutyDate === '2026-09-25')).toBe(false);
    expect(rows.some(r => r.dutyDate === '2026-10-02')).toBe(false);
  });
});
