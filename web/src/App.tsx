import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { MOCK } from './api/client';
import { Clawd } from './components/ui';
import { cx } from './lib/util';
import { useLive } from './live';
import { BoardPage } from './pages/Board';
import { ComposePage } from './pages/Compose';
import { InboxPage } from './pages/Inbox';
import { KnowledgePage } from './pages/Knowledge';
import { OverviewPage } from './pages/Overview';
import { ProjectsPage } from './pages/Projects';
import { SchedulesPage } from './pages/Schedules';

export function App() {
  const { inboxCount } = useLive();
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <span className="brand-logo" aria-hidden="true">
            🧠
          </span>
          Second Brain
        </span>
        <nav>
          <NavLink to="/" end>
            <span aria-hidden="true">🔭</span> Overview
          </NavLink>
          <NavLink to="/board">
            <span aria-hidden="true">🗂️</span> Board
          </NavLink>
          <NavLink to="/compose">
            <span aria-hidden="true">💬</span> Compose
          </NavLink>
          <NavLink to="/inbox">
            <span aria-hidden="true">📬</span> Inbox
            {inboxCount > 0 && (
              <span className="nav-badge" aria-label={`${inboxCount} items need you`}>
                {inboxCount}
              </span>
            )}
          </NavLink>
          <NavLink to="/schedules">
            <span aria-hidden="true">⏰</span> Schedules
          </NavLink>
          <NavLink to="/knowledge">
            <span aria-hidden="true">📚</span> Knowledge
          </NavLink>
          <NavLink to="/projects">
            <span aria-hidden="true">🧩</span> Projects
          </NavLink>
        </nav>
      </header>
      <div className="content">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/board" element={<BoardPage />} />
          <Route path="/compose" element={<ComposePage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/schedules" element={<SchedulesPage />} />
          <Route path="/knowledge" element={<KnowledgePage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      <StatusStrip />
    </div>
  );
}

function StatusStrip() {
  const { status, statusError, connected } = useLive();
  return (
    <footer className="status-strip">
      {MOCK && <span className="badge mock">mock data</span>}
      <span className={connected ? 'ok' : 'bad'} title="Live updates (SSE)">
        <span className={cx('live-pip', connected && 'on')} /> {connected ? 'live' : 'offline'}
      </span>
      {statusError && <span className="bad">backend: {statusError}</span>}
      {status && (
        <>
          <span>
            {status.running > 0 ? <Clawd working size={16} /> : '😴'} runs {status.running}/{status.concurrency}
          </span>
          <span>
            <Clawd size={16} /> claude {status.claude_version ?? 'not found'}
          </span>
          <span title="SQLite full-text search">🔎 {status.fts5 ? 'FTS5 search' : 'substring search (no FTS5)'}</span>
        </>
      )}
    </footer>
  );
}
