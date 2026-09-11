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
      <div className="settings-heading">
        <div>
          <h2>排班设置</h2>
          <p>人员、轮换和休假规则</p>
        </div>
        {dirty && <span className="dirty-mark">未保存</span>}
      </div>

      <section className="settings-section">
        <h3>休假管理</h3>
        <p className="settings-help">指定人员在特定日期不排班。</p>
        {exclusions.map((e, i) => (
          <div key={i} className="exclusion-item">
            <div className="form-row">
              <select
                className="settings-control"
                value={e.name}
                onChange={ev => changeExclusionName(i, ev.target.value)}
              >
                <option value="">选择人员</option>
                {activeNames.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              <button type="button" className="icon-button danger" onClick={() => removeExclusion(i)} aria-label="删除休假">×</button>
            </div>
            {e.dates.map((d, j) => (
              <div key={j} className="form-row">
                <input
                  className="settings-control"
                  type="date"
                  value={d}
                  onChange={ev => changeExclusionDate(i, j, ev.target.value)}
                />
                <button type="button" className="icon-button" onClick={() => removeExclusionDate(i, j)} aria-label="删除日期">×</button>
              </div>
            ))}
            <button type="button" className="add-button" onClick={() => addExclusionDate(i)}>＋ 添加日期</button>
          </div>
        ))}
        <button type="button" className="add-button" onClick={addExclusion}>＋ 添加休假</button>
      </section>

      <section className="settings-section">
        <h3>人员设置</h3>
        {members.map((m, i) => (
          <div key={i} className="form-row">
            <input
              className="settings-control"
              value={m.name}
              onChange={e => changeMember(i, 'name', e.target.value)}
              placeholder="姓名"
            />
            <select
              className="settings-control"
              value={m.role}
              onChange={e => changeMember(i, 'role', e.target.value)}
            >
              {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <button type="button" className="icon-button danger" onClick={() => removeMember(i)} aria-label="删除人员">×</button>
          </div>
        ))}
        <button type="button" className="add-button" onClick={addMember}>＋ 添加人员</button>
      </section>

      <section className="settings-section">
        <h3>周五轮换顺序</h3>
        <input
          className="settings-control rotation-input"
          value={rotation.join('、')}
          onChange={e => {
            setRotation(e.target.value.split(/[、,，\s]+/).filter(Boolean));
            setDirty(true);
          }}
        />
        <p className="settings-help">用顿号分隔人员姓名。</p>
      </section>

      <div className="settings-save-bar">
        <button onClick={save} disabled={!dirty} className="settings-save-button">保存设置</button>
      </div>
    </div>
  );
}
