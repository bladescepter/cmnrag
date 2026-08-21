import { useState, useEffect, useMemo, useRef } from 'react';
import { api } from '../api';
import type { ScheduleRowDB, PeriodStats, Member, CalendarData } from '../api';

/** 一行显示数据 — 覆盖全年每一天, 含值班日/周末/休刊 */
interface DisplayRow {
  date: string;
  weekday: string;
  isWeekend: boolean;
  isHoliday: boolean;
  isDutyDay: boolean;
  scheduleId: number | null;
  dutyDate: string | null;
  publishDate: string | null;
  firstEditor: string | null;
  secondEditor: string | null;
  remark: string | null;
  locked: boolean;
}

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function getWeekday(dateStr: string): string {
  return WEEKDAY_NAMES[new Date(dateStr + 'T00:00:00Z').getUTCDay()];
}

export default function TablePanel({
  refreshSignal,
  highlightRange,
  filterRange,
  scrollKey,
}: {
  refreshSignal: number;
  highlightRange: { start: string; end: string } | null;
  filterRange: { start: string; end: string };
  scrollKey: number;
}) {
  const [rows, setRows] = useState<ScheduleRowDB[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [calendar, setCalendar] = useState<CalendarData | null>(null);
  const [flash, setFlash] = useState(false);

  const load = async () => {
    try {
      const r = await api.getSchedule();
      setRows(r.rows ?? []);
    } catch { /* ignore */ }
  };


  useEffect(() => {
    load();
    api.getSettings().then(s => setMembers(s.members ?? [])).catch(() => {});
    api.getCalendar(2026).then(setCalendar).catch(() => {});
  }, []);

  useEffect(() => {
    if (refreshSignal > 0) {
      load();
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 1500);
      return () => clearTimeout(t);
    }
  }, [refreshSignal]);

  // 滚动到今日日期行
  useEffect(() => {
    if (scrollKey === 0) return;
    const today = new Date().toISOString().slice(0, 10);
    const row = document.querySelector(`[data-date="${today}"]`);
    if (row) {
      row.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }, [scrollKey]);

  const editorNames = useMemo(
    () => members.map(m => m.name),
    [members]
  );

  // duty_date → schedule row
  const scheduleMap = useMemo(() => {
    const m = new Map<string, ScheduleRowDB>();
    for (const r of rows) m.set(r.duty_date, r);
    return m;
  }, [rows]);

  // 生成全年 365 行, 合并 DB 排班
  const displayRows = useMemo<DisplayRow[]>(() => {
    if (!calendar) return [];
    const holidaySet = new Set(calendar.holidays);

    const allDays: DisplayRow[] = [];
    const start = new Date(Date.UTC(2026, 0, 1));
    const end = new Date(Date.UTC(2026, 11, 31));

    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      const dow = d.getUTCDay();
      const isWeekend = dow === 0 || dow === 6;
      const isHoliday = holidaySet.has(dateStr);
      const isDutyDay = !isWeekend && !isHoliday;

      if (isDutyDay) {
        // publish_date = 值班日的下一个见报日 (值班日 = 见报日的前一个见报日)
        let publishDate: string | null = null;
        for (const p of calendar.publishDates) {
          if (p > dateStr) { publishDate = p; break; }
        }
        const sched = scheduleMap.get(dateStr);
        allDays.push({
          date: dateStr,
          weekday: getWeekday(dateStr),
          isWeekend: false,
          isHoliday: false,
          isDutyDay: true,
          scheduleId: sched?.id ?? null,
          dutyDate: dateStr,
          publishDate: sched?.publish_date ?? publishDate,
          firstEditor: sched?.first_editor ?? null,
          secondEditor: sched?.second_editor ?? null,
          remark: sched?.remark ?? null,
          locked: sched?.locked === 1,
        });
      } else {
        // 周末/休刊日: 若有排班数据则显示, 否则显示"周末"/"休刊"
        const sched = scheduleMap.get(dateStr);
        if (sched) {
          allDays.push({
            date: dateStr,
            weekday: getWeekday(dateStr),
            isWeekend,
            isHoliday,
            isDutyDay: false,
            scheduleId: sched.id,
            dutyDate: dateStr,
            publishDate: sched.publish_date,
            firstEditor: sched.first_editor,
            remark: sched.remark,
            locked: sched.locked === 1,
          });
        } else {
          allDays.push({
            date: dateStr,
            weekday: getWeekday(dateStr),
            isWeekend,
            isHoliday,
            isDutyDay: false,
            scheduleId: null,
            dutyDate: null,
            publishDate: null,
            firstEditor: null,
            secondEditor: null,
            remark: isHoliday ? '休刊' : null,
            locked: false,
          });
        }
      }
    }
    return allDays;
  }, [calendar, scheduleMap]);

  // 日期筛选 (按 filterRange 范围)
  const filteredRows = useMemo(() => {
    const { start, end } = filterRange;
    if (!start && !end) return displayRows;
    return displayRows.filter(r => {
      const afterStart = !start || r.date >= start;
      const beforeEnd = !end || r.date <= end;
      return afterStart && beforeEnd;
    });
  }, [displayRows, filterRange]);

  const updateField = async (
    row: DisplayRow,
    field: 'firstEditor' | 'secondEditor' | 'remark',
    value: string
  ) => {
    const val = value || null;
    if (row.scheduleId !== null) {
      await api.updateRow(row.scheduleId, {
        dutyDate: row.dutyDate!,
        publishDate: row.publishDate!,
        weekday: row.weekday,
        firstEditor: field === 'firstEditor' ? val : row.firstEditor,
        secondEditor: field === 'secondEditor' ? val : row.secondEditor,
        remark: field === 'remark' ? val : row.remark,
      });
      load();
    } else {
      if (!val) return; // 空值不建新行
      await api.saveRow({
        dutyDate: row.dutyDate!,
        publishDate: row.publishDate!,
        weekday: row.weekday,
        firstEditor: field === 'firstEditor' ? val : null,
        secondEditor: field === 'secondEditor' ? val : null,
        remark: field === 'remark' ? val : null,
      });
      load();
    }
  };

  const toggleLock = async (row: DisplayRow) => {
    if (row.scheduleId === null) return;
    await api.toggleLock(row.scheduleId, !row.locked);
    load();
  };



  return (
    <div>
      <h3 style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        排班表 2026
        {flash && <span style={{ fontSize: 12, color: '#34c759', fontWeight: 400 }}>✓ 已更新</span>}
      </h3>


      <table className="schedule">
        <thead>
          <tr>
            <th>日期</th>
            <th>星期</th>
            <th>一版编辑</th>
            <th>二版编辑</th>
            <th>备注</th>
            <th>见报日期</th>
            <th>锁定</th>
          </tr>
        </thead>
        <tbody>
          {filteredRows.map(r => (
            <tr
              key={r.date}
              data-date={r.date}
              className={[
                r.isWeekend ? 'row-weekend' : '',
                r.isHoliday ? 'row-holiday' : '',
                highlightRange && r.date >= highlightRange.start && r.date <= highlightRange.end ? 'row-highlight' : '',
                r.locked ? 'row-locked' : '',
              ].filter(Boolean).join(' ')}
            >
              <td>{r.date}</td>
              <td>{r.weekday}</td>
              {r.isDutyDay || r.scheduleId !== null ? (
                <>
                  <td>
                    <select
                      value={r.firstEditor ?? ''}
                      onChange={e => updateField(r, 'firstEditor', e.target.value)}
                    >
                      <option value="">-</option>
                      {editorNames.map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </td>
                  <td>
                    <select
                      value={r.secondEditor ?? ''}
                      onChange={e => updateField(r, 'secondEditor', e.target.value)}
                    >
                      <option value="">-</option>
                      {editorNames.map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </td>
                  <td>
                    <input
                      key={`remark-${r.date}-${r.remark ?? ''}`}
                      defaultValue={r.remark ?? ''}
                      onBlur={e => updateField(r, 'remark', e.target.value)}
                      placeholder=""
                    />
                  </td>
                  <td>{r.publishDate ?? '-'}</td>
                  <td className="lock-cell">
                    {r.scheduleId !== null && (
                      <button
                        className={r.locked ? 'lock-btn locked' : 'lock-btn'}
                        onClick={() => toggleLock(r)}
                        title={r.locked ? '点击解锁' : '点击锁定'}
                      >
                        {r.locked ? '🔒' : '🔓'}
                      </button>
                    )}
                  </td>
                </>
              ) : (
                <td colSpan={5} className="non-duty-cell">
                  {r.isHoliday ? '休刊' : '周末'}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
