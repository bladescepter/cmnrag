import { useEffect, useState } from 'react';
import { api } from './api';
import { RANGE_START, RANGE_END, RANGE_LABEL } from './range';
import TablePanel from './panels/TablePanel';
import GeneratePanel from './panels/GeneratePanel';
import SettingsPanel from './panels/SettingsPanel';

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [user, setUser] = useState<{ username: string } | null>(null);
  const [scheduleVersion, setScheduleVersion] = useState(0);
  const [highlightRange, setHighlightRange] = useState<{ start: string; end: string } | null>(null);
  const [filterRange, setFilterRange] = useState<{ start: string; end: string }>({
    start: RANGE_START,
    end: RANGE_END,
  });
  const [scrollKey, setScrollKey] = useState(0);

  // 主系统登录态检测（复用 cmnrag 会话 cookie）
  useEffect(() => {
    api.me().then(u => { setUser(u); setAuthed(true); }).catch(() => setAuthed(false));
  }, []);

  if (authed === null) {
    return <div className="login-box"><h2>正在检测登录…</h2></div>;
  }

  if (!authed) {
    return <NotLoggedIn />;
  }

  return (
    <>
      <div id="auth-bar"><div className="auth-bar-inner"><div className="auth-left"><a className="auth-home" href="/">‹ 返回主页</a></div><nav className="auth-nav"><a className="auth-link" href="/db">报纸资料库</a><a className="auth-link active" href="/schedule">排班系统</a></nav><div className="auth-right"><span className="auth-name">{user?.username ?? ''}</span><form method="post" action="/api/auth/logout" style={{ display: 'inline' }}><button type="submit" className="auth-link auth-btn" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#d5e5ff', fontSize: 13.5, padding: '6px 12px', borderRadius: 6 }}>退出登录</button></form></div></div></div>
      <header className="app-header">
        <h1>排班工具</h1>
      </header>
      <div className="app-body">
        <div className="left-panel">
          <TablePanel
            refreshSignal={scheduleVersion}
            highlightRange={highlightRange}
            filterRange={filterRange}
            scrollKey={scrollKey}
          />
        </div>
        <div className="right-panel">
          <GeneratePanel
            onGenerated={(range) => {
              setHighlightRange(range);
              setScheduleVersion(v => v + 1);
            }}
            filterRange={filterRange}
            onFilterChange={setFilterRange}
            onShowAll={() => {
              setFilterRange({ start: RANGE_START, end: RANGE_END });
              setScrollKey(k => k + 1);
            }}
            onRefresh={() => setScheduleVersion(v => v + 1)}
          />
          <SettingsPanel />
        </div>
      </div>
    </>
  );
}

function NotLoggedIn() {
  return (
    <div className="login-box">
      <h2>请先登录</h2>
      <p style={{ fontSize: 13, color: '#666', margin: '0 0 16px' }}>排班系统使用资料库账号，请先登录后再使用。</p>
      <a href="/login.html" style={{ display: 'inline-block', padding: '9px 20px', background: '#155eef', color: '#fff', borderRadius: 6, textDecoration: 'none', fontSize: 14 }}>前往登录</a>
      <p style={{ fontSize: 11, color: '#999', marginTop: 14 }}>没有账号？需管理员审批后开通</p>
    </div>
  );
}
