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

  it('均衡: 9-10 月周期 both 人员版数全部相等 (差异 ≤ 1), 刘钊 ≤2, 史光浩 =3', () => {
    const startIdx = (settings.fridayRotation.indexOf('李悦') + 1) % settings.fridayRotation.length;
    const rows = generateSchedule({ anchorDate: '2026-09-20', entries, settings, fridayRotationStart: startIdx });
    const inRange = rows.filter(r => r.dutyDate >= '2026-09-15' && r.dutyDate <= '2026-10-14');
    const stat = new Map<string, { first: number; second: number }>();
    for (const r of inRange) {
      for (const [n, role] of [[r.firstEditor, 'first'], [r.secondEditor, 'second']] as const) {
        if (!n) continue;
        if (!stat.has(n)) stat.set(n, { first: 0, second: 0 });
        if (role === 'first') stat.get(n)!.first++; else stat.get(n)!.second++;
      }
    }
    // 刘钊硬限: 每周期 ≤ 2
    const liu = stat.get('刘钊');
    expect(liu ? liu.first + liu.second : 0).toBeLessThanOrEqual(2);
    // 史光浩(second_only) 硬限: ≤ 理想配额 3
    const shi = stat.get('史光浩');
    expect(shi ? shi.first + shi.second : 0).toBeLessThanOrEqual(3);
    // both 人员 (排除刘钊/史光浩): 版数差 ≤ 1
    const bothTotals = [...stat.entries()]
      .filter(([n]) => n !== '刘钊' && n !== '史光浩')
      .map(([, s]) => s.first + s.second);
    expect(bothTotals.length).toBeGreaterThan(0);
    expect(Math.max(...bothTotals) - Math.min(...bothTotals)).toBeLessThanOrEqual(1);
    // 用户点名场景: 张宏伟 3 版, 黄彬 3 版 (不再 张2 黄4)
    const zhang = stat.get('张宏伟');
    const huang = stat.get('黄彬');
    expect(zhang ? zhang.first + zhang.second : 0).toBe(3);
    expect(huang ? huang.first + huang.second : 0).toBe(3);
  });

  it('确定性: 两次生成结果完全一致 (无随机性)', () => {
    const startIdx = (settings.fridayRotation.indexOf('李悦') + 1) % settings.fridayRotation.length;
    const r1 = generateSchedule({ anchorDate: '2026-09-20', entries, settings, fridayRotationStart: startIdx });
    const r2 = generateSchedule({ anchorDate: '2026-09-20', entries, settings, fridayRotationStart: startIdx });
    expect(r1).toEqual(r2);
  });

  it('刘钊永不超限: 即使候选池紧张也守 liuZhaoMax', () => {
    // 构造大量一版槽的周期, 验证刘钊最多 2 个一版
    const rows = generateSchedule({ anchorDate: '2026-09-20', entries, settings, fridayRotationStart: 0 });
    const liuRows = rows.filter(r => r.firstEditor === '刘钊');
    expect(liuRows.length).toBeLessThanOrEqual(2);
  });

  it('刘钊名额分散: 两个一版一个在前 1/3、一个在后 1/3, 不挤在开头或末尾', () => {
    const startIdx = (settings.fridayRotation.indexOf('李悦') + 1) % settings.fridayRotation.length;
    const rows = generateSchedule({ anchorDate: '2026-09-20', entries, settings, fridayRotationStart: startIdx });
    const inRange = rows.filter(r => r.dutyDate >= '2026-09-15' && r.dutyDate <= '2026-10-14');
    const positions = inRange
      .map((r, i) => (r.firstEditor === '刘钊' ? i : -1))
      .filter(i => i >= 0);
    expect(positions.length).toBe(2);
    // 一个在前 1/3, 一个在后 1/3
    const early = positions.some(i => i < inRange.length / 3);
    const late = positions.some(i => i >= (inRange.length * 2) / 3);
    expect(early && late).toBe(true);
    // 不相邻 (间隔至少 3 行)
    expect(Math.abs(positions[0] - positions[1])).toBeGreaterThanOrEqual(3);
  });
});
