import { useState, useEffect, useMemo } from 'react';
import { api } from '../api';
import { RANGE_YEARS } from '../range';
import type { PeriodStats } from '../api';

interface Cycle {
  label: string;       // 显示标签
  start: string;       // 值班日期范围起 (见报日 - 1天)
  end: string;         // 值班日期范围止 (见报日 - 1天)
  publishStart: string; // 见报日期起
  publishEnd: string;   // 见报日期止
}

export default function GeneratePanel({
  onGenerated,
  filterRange,
  onFilterChange,
  onShowAll,
  onRefresh,
}: {
  onGenerated: (range: { start: string; end: string }) => void;
  filterRange: { start: string; end: string };
  onFilterChange: (range: { start: string; end: string }) => void;
  onShowAll: () => void;
  onRefresh: () => void;
}) {
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState('');
  const [stats, setStats] = useState<PeriodStats | null>(null);
  const [filterMode, setFilterMode] = useState<'cycle' | 'date'>('cycle');
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [selectedCycleIdx, setSelectedCycleIdx] = useState(0);

  // 加载周期列表 (后端统一计算, 避免前后端逻辑重复; 跨年合并两个年份的周期)
  useEffect(() => {
    Promise.all(RANGE_YEARS.map(y => api.getCalendarCycles(y)))
      .then(results => {
        const computed: Cycle[] = results.flatMap(r =>
          r.cycles.map(c => {
            const startMonth = Number(c.publishStart.slice(5, 7));
            const endMonth = Number(c.publishEnd.slice(5, 7));
            return {
              label: `${c.publishStart.slice(0, 4)} ${startMonth}-${endMonth}月 (${c.publishStart.slice(5)} ~ ${c.publishEnd.slice(5)}见报)`,
              start: c.dutyStart,
              end: c.dutyEnd,
              publishStart: c.publishStart,
              publishEnd: c.publishEnd,
            };
          })
        );
        setCycles(computed);
        if (computed.length > 0) {
          onFilterChange({ start: computed[0].start, end: computed[0].end });
        }
      })
      .catch(() => {});
  }, []);

  // 范围内统计
  useEffect(() => {
    if (!filterRange.start || !filterRange.end) { setStats(null); return; }
    api.getSchedule(filterRange.start, filterRange.end)
      .then(r => setStats(r.stats))
      .catch(() => setStats(null));
  }, [filterRange.start, filterRange.end]);

  const handleCycleSelect = (idx: number) => {
    setSelectedCycleIdx(idx);
    const c = cycles[idx];
    if (c) onFilterChange({ start: c.start, end: c.end });
  };

  const handleGenerate = async () => {
    if (generating) return;
    if (!filterRange.start || !filterRange.end) {
      setMessage('请先选择排班周期');
      return;
    }
    setGenerating(true);
    setMessage('正在生成排班…');
    try {
      const result = await api.generateCycle(
        filterRange.start, filterRange.end
      );
      if (result.ok) {
        onGenerated(result.cycle);
        // 刷新次数统计
        api.getSchedule(filterRange.start, filterRange.end)
          .then(r => setStats(r.stats))
          .catch(() => {});
        const parts = [`✓ 已生成 ${result.cycle.start} → ${result.cycle.end}`];
        if (result.skippedLocked > 0) parts.push(`(保留 ${result.skippedLocked} 行锁定)`);
        setMessage(parts.join(' '));
        setTimeout(() => setMessage(''), 5000);
      } else {
        setMessage(result.error ?? '生成失败');
      }
    } catch (e: unknown) {
      setMessage(e instanceof Error ? e.message : '生成失败');
    }
    setGenerating(false);
  };

  const handleClear = async () => {
    if (!filterRange.start || !filterRange.end) return;
    const msg = `确定要清空 ${filterRange.start} 至 ${filterRange.end} 范围内的全部排班吗？\n锁定行将被保留。此操作不可撤销。`;
    if (!window.confirm(msg)) return;
    await api.clearRange(filterRange.start, filterRange.end);
    onRefresh();
  };

  const cycleOptions = useMemo(() => {
    return cycles.map((c, i) => ({ idx: i, label: c.label }));
  }, [cycles]);

  return (
    <div className="generate-panel">
      <button
        onClick={handleGenerate}
        disabled={generating || filterMode === 'date'}
        className="btn-generate"
      >
        {generating ? '生成中…' : '生成本周期排班'}
      </button>
      <div className="gen-hint">请先在下方选择排班周期，再点击生成</div>
      {message && <span className="gen-message">{message}</span>}

      <div className="filter-tabs">
        <button
          className={filterMode === 'cycle' ? 'filter-tab active' : 'filter-tab'}
          onClick={() => { setFilterMode('cycle'); handleCycleSelect(selectedCycleIdx); }}
        >按周期筛选</button>
        <button
          className={filterMode === 'date' ? 'filter-tab active' : 'filter-tab'}
          onClick={() => { setFilterMode('date'); onShowAll(); }}
        >按年筛选</button>
      </div>

      {filterMode === 'cycle' ? (
        <div className="filter-section">
          <select
            className="cycle-select"
            value={selectedCycleIdx}
            onChange={e => handleCycleSelect(Number(e.target.value))}
          >
            {cycleOptions.map(o => (
              <option key={o.idx} value={o.idx}>{o.label}</option>
            ))}
          </select>
        </div>
      ) : (
        <div className="filter-section">
          <div className="filter-range">
            <input
              type="date"
              value={filterRange.start}
              onChange={e => onFilterChange({ ...filterRange, start: e.target.value })}
            />
            <span>至</span>
            <input
              type="date"
              value={filterRange.end}
              onChange={e => onFilterChange({ ...filterRange, end: e.target.value })}
            />
          </div>
        </div>
      )}

      {stats && (
        <div className="stats-bar">
          {Object.entries(stats.perPerson).map(([name, c]) => (
            <span key={name}>{name}{c.total}（一{c.first}二{c.second}）</span>
          ))}
        </div>
      )}

      <button
        onClick={handleClear}
        className="btn-clear"
        style={{ width: '100%' }}
        title="清空当前筛选范围内未锁定的排班"
      >
        清屏
      </button>
    </div>
  );
}
