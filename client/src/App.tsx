import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api, type Complaint } from './api';
import Dashboard from './pages/Dashboard';
import Ingest from './pages/Ingest';
import Genealogy from './pages/Genealogy';
import Forward from './pages/Forward';
import Backward from './pages/Backward';
import Recall from './pages/Recall';
import Quality from './pages/Quality';
import Reports from './pages/Reports';

const NAV = [
  { to: '/', num: '总', label: '生产概览' },
  { to: '/ingest', num: '01', label: '数据接入' },
  { to: '/genealogy', num: '02', label: '批次谱系' },
  { to: '/forward', num: '03', label: '正向追溯' },
  { to: '/backward', num: '04', label: '反向追溯' },
  { to: '/quality', num: '05', label: '质量与可疑批次' },
  { to: '/recall', num: '06', label: '召回模拟' },
  { to: '/reports', num: '07', label: '8D 报告' }
];

export default function App() {
  const loc = useLocation();
  const [complaint, setComplaint] = useState<Complaint | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);

  useEffect(() => {
    api.complaint().then(setComplaint).catch(() => {});
    api.health().then((h) => setReady(h.ready)).catch(() => setReady(false));
  }, []);

  const current = NAV.find((n) => n.to === loc.pathname) ?? NAV[0];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <span className="brand-dot">卡</span>
            <span>批次追溯系统</span>
          </div>
          <div className="brand-sub">刹车卡钳 · MES / WMS / QMS 融合</div>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <span className="nav-num">{n.num}</span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          {ready === false && <div style={{ color: 'var(--warn)' }}>数据库为空，请先运行 npm run seed && npm run ingest</div>}
          {complaint && (
            <>
              <div style={{ color: 'var(--text-dim)' }}>当前投诉</div>
              <div className="mono" style={{ color: '#ffb4af', margin: '3px 0' }}>{complaint.complaint_no}</div>
              <div>{complaint.customer_name}</div>
              <div className="mono faint">炉号 {complaint.heat_lot}</div>
            </>
          )}
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <h1>{current.label}</h1>
          <span className="crumb">/ {current.to === '/' ? 'dashboard' : current.to.slice(1)}</span>
          <div className="topbar-right">
            <span>2025-09 月结 · 模拟生产数据</span>
            <span className="tag tag-gray">演示环境</span>
          </div>
        </div>
        <div className="content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/ingest" element={<Ingest />} />
            <Route path="/genealogy" element={<Genealogy />} />
            <Route path="/forward" element={<Forward />} />
            <Route path="/backward" element={<Backward />} />
            <Route path="/quality" element={<Quality />} />
            <Route path="/recall" element={<Recall />} />
            <Route path="/reports" element={<Reports />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
