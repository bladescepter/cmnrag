import { useState, useEffect } from 'react';
import { api } from '../api';
import type { Member, Exclusion } from '../api';

const ROLE_LABELS: Record<string, string> = {
  both: '一版+二版',
  first_only: '仅一版',
  second_only: '仅二版',
  inactive: '不参与',
};

export default function SettingsPanel() {
  const [members, setMembers] = useState<Member[]>([]);
  const [rotation, setRotation] = useState<string[]>([]);
  const [exclusions, setExclusions] = useState<Exclusion[]>([]);
  const [dirty, setDirty] = useState(false);

  const load = async () => {
    try {
      const s = await api.getSettings();
      setMembers(s.members ?? []);
      setRotation(s.fridayRotation ?? []);
      setExclusions(s.exclusions ?? []);
    } catch (e) {}
  };

  useEffect(() => { load(); }, []);

  const addMember = () => {
    setMembers([...members, { name: '', role: 'both' }]);
    setDirty(true);
  };
  const removeMember = (i: number) => {
    setMembers(members.filter((_, j) => j !== i));
    setDirty(true);
  };
  const changeMember = (i: number, field: string, value: string) => {
    setMembers(members.map((m, j) => (j === i ? { ...m, [field]: value } : m)));
    setDirty(true);
  };

  // ── 休假管理 ──
  const addExclusion = () => {
    setExclusions([...exclusions, { name: '', dates: [] }]);
    setDirty(true);
  };
  const removeExclusion = (i: number) => {
    setExclusions(exclusions.filter((_, j) => j !== i));
    setDirty(true);
  };
  const changeExclusionName = (i: number, name: string) => {
    setExclusions(exclusions.map((e, j) => (j === i ? { ...e, name } : e)));
    setDirty(true);
  };
  const addExclusionDate = (i: number) => {
    setExclusions(exclusions.map((e, j) => (j === i ? { ...e, dates: [...e.dates, ''] } : e)));
    setDirty(true);
  };
  const changeExclusionDate = (ei: number, di: number, date: string) => {
    setExclusions(exclusions.map((e, j) =>
      j === ei ? { ...e, dates: e.dates.map((d, k) => k === di ? date : d) } : e
    ));
    setDirty(true);
  };
  const removeExclusionDate = (ei: number, di: number) => {
    setExclusions(exclusions.map((e, j) =>
      j === ei ? { ...e, dates: e.dates.filter((_, k) => k !== di) } : e
    ));
    setDirty(true);
  };

  const save = async () => {
    await api.updateSettings(members, rotation, exclusions);
    setDirty(false);
    load();
  };

  const activeNames = members.filter(m => m.role !== 'inactive').map(m => m.name);

  return (
    <div className="settings-panel">
      <h3 style={{ fontSize: 14, marginBottom: 6 }}>休假管理</h3>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>指定人员在特定日期不排班</div>
      {exclusions.map((e, i) => (
        <div key={i} style={{ border: '1px solid #ddd', borderRadius: 4, padding: 6, marginBottom: 6 }}>
          <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            <select
              style={{ flex: 1, padding: '2px', border: '1px solid #ccc', borderRadius: 4 }}
              value={e.name}
              onChange={ev => changeExclusionName(i, ev.target.value)}
            >
              <option value="">选择人员</option>
              {activeNames.map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <button onClick={() => removeExclusion(i)} style={{ padding: '0 6px', cursor: 'pointer', border: 'none', background: '#ff3b30', color: '#fff', borderRadius: 4 }}>✕</button>
          </div>
          {e.dates.map((d, j) => (
            <div key={j} style={{ display: 'flex', gap: 4, marginBottom: 2 }}>
              <input
                type="date"
                style={{ flex: 1, padding: '2px 4px', border: '1px solid #ccc', borderRadius: 4, fontSize: 12 }}
                value={d}
                onChange={ev => changeExclusionDate(i, j, ev.target.value)}
              />
              <button onClick={() => removeExclusionDate(i, j)} style={{ padding: '0 6px', cursor: 'pointer', border: 'none', background: '#ddd', color: '#333', borderRadius: 4, fontSize: 11 }}>✕</button>
            </div>
          ))}
          <button onClick={() => addExclusionDate(i)} style={{ padding: '2px 6px', cursor: 'pointer', border: '1px solid #ccc', background: '#fff', borderRadius: 4, fontSize: 11, marginTop: 2 }}>+ 添加日期</button>
        </div>
      ))}
      <button onClick={addExclusion} style={{ padding: '4px 8px', cursor: 'pointer', border: '1px solid #ccc', background: '#fff', borderRadius: 4, fontSize: 12 }}>+ 添加休假</button>

      <h3 style={{ fontSize: 14, margin: '12px 0 6px' }}>人员设置</h3>
      {members.map((m, i) => (
        <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
          <input
            style={{ flex: 1, padding: '2px 4px', border: '1px solid #ccc', borderRadius: 4 }}
            value={m.name}
            onChange={e => changeMember(i, 'name', e.target.value)}
            placeholder="姓名"
          />
          <select
            style={{ flex: 1, padding: '2px', border: '1px solid #ccc', borderRadius: 4 }}
            value={m.role}
            onChange={e => changeMember(i, 'role', e.target.value)}
          >
            {Object.entries(ROLE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <button onClick={() => removeMember(i)} style={{ padding: '0 6px', cursor: 'pointer', border: 'none', background: '#ff3b30', color: '#fff', borderRadius: 4 }}>✕</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button onClick={addMember} style={{ padding: '4px 8px', cursor: 'pointer', border: '1px solid #ccc', background: '#fff', borderRadius: 4 }}>+ 添加</button>
        {dirty && <button onClick={save} style={{ padding: '4px 12px', cursor: 'pointer', border: 'none', background: '#34c759', color: '#fff', borderRadius: 4 }}>保存</button>}
      </div>

      <h3 style={{ fontSize: 14, margin: '12px 0 6px' }}>周五轮换顺序</h3>
      <input
        style={{ width: '100%', padding: '4px', border: '1px solid #ccc', borderRadius: 4 }}
        value={rotation.join('、')}
        onChange={e => {
          setRotation(e.target.value.split(/[、,，\s]+/).filter(Boolean));
          setDirty(true);
        }}
      />
      <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>用顿号分隔</div>
    </div>
  );
}
