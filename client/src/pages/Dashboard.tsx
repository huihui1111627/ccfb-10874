import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Complaint } from '../api';
import type { DashboardStats } from '../../../shared/types';
import { Card, ErrorBox, Loading, Stat, StageTag, qty } from '../components/ui';

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [complaint, setComplaint] = useState<Complaint | null>(null);
  const [error, setError] = useState('');
  const [validation, setValidation] = useState<{ ok: boolean; lineage: { accuracy: number }; data_quality: { detected_issues: number; injected_issues: number } } | null>(null);

  useEffect(() => {
    api.stats().then(setStats).catch((e) => setError(e.message));
    api.complaint().then(setComplaint).catch(() => {});
    api.validate().then(setValidation).catch(() => {});
  }, []);

  if (error) return <ErrorBox error={error} />;
  if (!stats) return <Loading />;

  const maxDaily = Math.max(...stats.daily_output.map((d) => d.qty), 1);

  return (
    <>
      <div className="section-head">
        <h2>2025 年 9 月生产全景</h2>
        <p>{stats.date_range.from} — {stats.date_range.to} · 26 个工作日 · 单班制</p>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat label="批次总数" value={qty(stats.lots)} sub={`原料 ${stats.raw_lots} · 成品 ${stats.finished_lots}`} />
        <Stat label="谱系边" value={qty(stats.edges)} sub="父子批次流转关系" tone="blue" />
        <Stat label="成品序列号" value={qty(stats.serials)} sub={`${stats.shipments} 张发货单 / ${stats.customers} 家客户`} />
        <Stat label="可疑批次" value={qty(stats.suspect_lots)} sub={`${stats.failed_inspections} 条质检不合格`} tone={stats.suspect_lots > 0 ? 'danger' : 'ok'} />
      </div>

      {complaint && (
        <div className="card" style={{ borderColor: 'rgba(255,95,86,.35)', background: 'linear-gradient(180deg, rgba(255,95,86,.06), transparent)' }}>
          <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 420px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span className="tag tag-red">客户投诉</span>
                <span className="mono" style={{ color: '#ffaaa4' }}>{complaint.complaint_no}</span>
                <span className="faint small">{complaint.reported_at}</span>
              </div>
              <div style={{ fontSize: 14, fontWeight: 550, marginBottom: 6 }}>{complaint.customer_name}</div>
              <div className="muted" style={{ lineHeight: 1.7, maxWidth: 720 }}>{complaint.issue}</div>
              <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                <Link to={`/forward?lot=${complaint.heat_lot}`} className="btn btn-primary btn-sm">正向追溯该炉号</Link>
                <Link to={`/backward?serial=${complaint.serials[0] ?? ''}`} className="btn btn-sm">按序列号反查</Link>
                <Link to="/recall" className="btn btn-sm">召回模拟</Link>
              </div>
            </div>
            <div style={{ minWidth: 220 }}>
              <div className="kv">
                <dt>疑似炉号</dt><dd className="mono" style={{ color: '#ffc061' }}>{complaint.heat_lot}</dd>
                <dt>产品</dt><dd>{complaint.product}</dd>
                <dt>客户序列号</dt><dd className="mono">{complaint.serials.slice(0, 2).join(', ')}{complaint.serials.length > 2 ? ` +${complaint.serials.length - 2}` : ''}</dd>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <Card title="工序产出构成" hint="按工段汇总批次数量与产出量（单位：件，已折合毛坯件数）">
          <table className="data">
            <thead><tr><th>工序</th><th className="num">批次数</th><th className="num">产出量(件)</th><th style={{ width: '34%' }}>占比</th></tr></thead>
            <tbody>
              {stats.by_stage.map((s) => {
                const max = Math.max(...stats.by_stage.map((x) => x.qty), 1);
                return (
                  <tr key={s.stage}>
                    <td><StageTag stage={s.stage} /> <span className="muted" style={{ marginLeft: 6 }}>{s.name}</span></td>
                    <td className="num">{s.lots}</td>
                    <td className="num">{qty(s.qty)}</td>
                    <td>
                      <div className="bar"><i style={{ width: `${(s.qty / max) * 100}%` }} /></div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>

        <Card title="每日成品产出" hint="柱高为入库件数，底部标记报废">
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 156, paddingTop: 8 }}>
            {stats.daily_output.filter((d) => d.qty > 0).map((d) => (
              <div key={d.date} title={`${d.date} 产出 ${qty(d.qty)} 件，报废 ${d.scrap}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }}>
                <div style={{ height: `${(d.qty / maxDaily) * 100}%`, background: 'linear-gradient(180deg,#4c9aff,#2f6dc4)', borderRadius: '2px 2px 0 0', minHeight: 3 }} />
                {d.scrap > 0 && <div style={{ height: `${Math.max(2, (d.scrap / maxDaily) * 60)}%`, background: 'rgba(255,95,86,.65)' }} />}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }} className="faint small">
            <span>{stats.date_range.from}</span>
            <span>{stats.date_range.to}</span>
          </div>
        </Card>
      </div>

      <Card title="追溯能力自检" hint="与生成时保留的真实谱系逐批对照" actions={<Link to="/ingest" className="btn btn-sm">查看数据接入</Link>}>
        <div className="grid cols-3">
          <div>
            <div className="stat-label">谱系还原准确率</div>
            <div className="stat-value" style={{ color: validation?.ok ? 'var(--ok)' : 'var(--warn)' }}>
              {validation ? `${(validation.lineage.accuracy * 100).toFixed(1)}%` : '—'}
            </div>
            <div className="stat-sub">真实父子边 vs 系统推断边</div>
          </div>
          <div>
            <div className="stat-label">数量守恒</div>
            <div className="stat-value" style={{ color: validation?.ok ? 'var(--ok)' : 'var(--warn)' }}>{validation?.ok ? '通过' : '待核'}</div>
            <div className="stat-sub">逐工序投入 = 产出 + 报废</div>
          </div>
          <div>
            <div className="stat-label">数据问题识别</div>
            <div className="stat-value">{validation?.data_quality.detected_issues ?? '—'}</div>
            <div className="stat-sub">注入 {validation?.data_quality.injected_issues ?? '—'} 处，系统检出</div>
          </div>
        </div>
      </Card>
    </>
  );
}
