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
      <div id="auth-bar">
        <div className="auth-bar-inner">
          <div className="auth-left"><a className="auth-home" href="/">‹ 返回主页</a></div>
          <nav className="auth-nav" aria-label="模块导航">
            <a className="auth-link" href="/db">报纸资料库</a>
            <a className="auth-link active" href="/schedule">排班系统</a>
          </nav>
          <div className="auth-right">
            <span className="auth-name">{user?.username ?? ''}</span>
            <form method="post" action="/api/auth/logout" className="logout-form">
              <button type="submit" className="auth-link auth-btn">退出登录</button>
            </form>
          </div>
        </div>
      </div>
      <header className="app-header">
        <div>
          <p className="app-kicker">采访中心工具集 · 工作台</p>
          <h1>排班工具</h1>
        </div>
        <p className="app-period">排班周期：{RANGE_LABEL}</p>
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
      <p>排班系统使用资料库账号，请先登录后再使用。</p>
      <a href="/login.html">前往登录</a>
      <p className="login-note">没有账号？需管理员审批后开通</p>
    </div>
  );
}
