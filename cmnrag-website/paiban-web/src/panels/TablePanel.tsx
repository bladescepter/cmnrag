import { useState, useEffect, useMemo, useRef } from 'react';
import { api } from '../api';
import { RANGE_START, RANGE_END, RANGE_YEARS, RANGE_LABEL } from '../range';
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
  lockedFirst: boolean;
  lockedSecond: boolean;
}

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 锁形图标 (closed=实心已锁, open=空心未锁) */
function LockIcon({ open = false }: { open?: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="4" y="11" width="16" height="10" rx="2"
        fill={open ? 'none' : 'currentColor'}
        stroke="currentColor" strokeWidth="2.5"
      />
      <path
        d={open ? 'M8 11V7a4 4 0 0 1 7.6-1.2' : 'M8 11V7a4 4 0 0 1 8 0v4'}
        fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
      />
    </svg>
  );
}

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
    // 跨年合并: 每个范围年份取一次日历, 合并见报日/休刊集合
    Promise.all(RANGE_YEARS.map(y => api.getCalendar(y)))
      .then(list => {
        if (list.length === 0) return;
        setCalendar({
          year: RANGE_YEARS[RANGE_YEARS.length - 1],
          publishDates: [...new Set(list.flatMap(c => c.publishDates))].sort(),
          holidays: [...new Set(list.flatMap(c => c.holidays))].sort(),
        });
      })
      .catch(() => {});
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
    const [sy, sm, sd] = RANGE_START.split('-').map(Number);
    const [ey, em, ed] = RANGE_END.split('-').map(Number);
    const start = new Date(Date.UTC(sy, sm - 1, sd));
    const end = new Date(Date.UTC(ey, em - 1, ed));

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
          lockedFirst: sched?.locked_first === 1,
          lockedSecond: sched?.locked_second === 1,
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
            lockedFirst: sched.locked_first === 1,
            lockedSecond: sched.locked_second === 1,
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
            lockedFirst: false,
            lockedSecond: false,
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

  const toggleLock = async (row: DisplayRow, side: 'first' | 'second') => {
    if (row.scheduleId === null) return;
    const locked = side === 'first' ? row.lockedFirst : row.lockedSecond;
    await api.toggleLock(row.scheduleId, { [side]: !locked });
    load();
  };

  // 锁定钮: 未锁定格悬停才浮现, 已锁定格常驻小锁点 (视觉噪音 ∝ 锁定数)
  const lockBtn = (row: DisplayRow, side: 'first' | 'second') => {
    const locked = side === 'first' ? row.lockedFirst : row.lockedSecond;
    return (
      <button
        type="button"
        className={locked ? 'cell-lock locked' : 'cell-lock'}
        onClick={() => toggleLock(row, side)}
        title={locked ? '已锁定，生成排班时保留；点击解锁' : '锁定该格，生成排班时保留'}
        disabled={row.scheduleId === null}
      >
        <LockIcon open={!locked} />
      </button>
    );
  };



  return (
    <div>
      <h3 style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        排班表 {RANGE_LABEL}
        {flash && <span style={{ fontSize: 12, color: '#34c759', fontWeight: 400 }}>✓ 已更新</span>}
      </h3>
      <p className="lock-hint">悬停编辑格浮现小锁，点击锁定；锁定格生成排班时保留原编辑</p>


      <table className="schedule">
        <thead>
          <tr>
            <th>日期</th>
            <th>星期</th>
            <th>一版编辑</th>
            <th>二版编辑</th>
            <th>备注</th>
            <th>见报日期</th>
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
              ].filter(Boolean).join(' ')}
            >
              <td>{r.date}</td>
              <td>{r.weekday}</td>
              {r.isDutyDay || r.scheduleId !== null ? (
                <>
                  <td className={(r.isDutyDay || r.scheduleId !== null) && r.lockedFirst ? 'cell-locked' : ''}>
                    <span className="cell-editor">
                      <select
                        value={r.firstEditor ?? ''}
                        onChange={e => updateField(r, 'firstEditor', e.target.value)}
                      >
                        <option value="">-</option>
                        {editorNames.map(n => <option key={n} value={n}>{n}</option>)}
                      </select>
                      {lockBtn(r, 'first')}
                    </span>
                  </td>
                  <td className={(r.isDutyDay || r.scheduleId !== null) && r.lockedSecond ? 'cell-locked' : ''}>
                    <span className="cell-editor">
                      <select
                        value={r.secondEditor ?? ''}
                        onChange={e => updateField(r, 'secondEditor', e.target.value)}
                      >
                        <option value="">-</option>
                        {editorNames.map(n => <option key={n} value={n}>{n}</option>)}
                      </select>
                      {lockBtn(r, 'second')}
                    </span>
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
