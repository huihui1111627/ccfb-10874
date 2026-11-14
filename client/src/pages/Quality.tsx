import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type InspRow } from '../api';
import { Card, Empty, ErrorBox, Loading, StageTag, Stat, qty, time } from '../components/ui';

export default function Quality() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.quality>> | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'fail' | 'suspect'>('fail');
  const [validation, setValidation] = useState<Awaited<ReturnType<typeof api.validate>> | null>(null);

  useEffect(() => {
    api.quality().then(setData).catch((e) => setError(e.message));
    api.validate().then(setValidation).catch(() => {});
  }, []);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const byItem = new Map<string, { count: number; fails: number }>();
  for (const f of data.failures) {
    const cur = byItem.get(f.item) ?? { count: 0, fails: 0 };
    cur.fails++;
    byItem.set(f.item, cur);
  }

  const failRows = data.failures;

  return (
    <>
      <div className="section-head">
        <h2>质量不合格与可疑批次传播</h2>
        <p>IQC / IPQC / FQC 不合格自动标记本批及全部下游批次，并预估影响范围</p>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat label="不合格检验单" value={failRows.length} sub={`覆盖 ${new Set(failRows.map((f) => f.lot_no)).size} 个批次`} tone="danger" />
        <Stat label="可疑批次总数" value={data.suspect_count} sub="含下游传播标记" tone="warn" />
        <Stat label="直接不合格批次" value={new Set(failRows.map((f) => f.lot_no)).size} sub="质检判定源头" />
        <Stat label="数据矛盾自动改判" value={validation?.data_quality.corrections_applied ?? '—'} sub="实测超限但录为 PASS" tone="blue" />
      </div>

      <div className="split-wide">
        <Card
          title="不合格检验记录"
          hint="点击批次进入谱系"
          actions={
            <div style={{ display: 'flex', gap: 4 }}>
              <button className={`btn btn-sm ${tab === 'fail' ? 'btn-primary' : ''}`} onClick={() => setTab('fail')}>不合格单</button>
              <button className={`btn btn-sm ${tab === 'suspect' ? 'btn-primary' : ''}`} onClick={() => setTab('suspect')}>可疑批次</button>
            </div>
          }
        >
          {tab === 'fail' ? (
            <div className="scroll" style={{ maxHeight: 520 }}>
              <table className="data">
                <thead><tr><th>检验单</th><th>类型</th><th>批次</th><th>检验项</th><th className="num">实测</th><th className="num">规格</th><th>时间</th></tr></thead>
                <tbody>
                  {failRows.map((f) => (
                    <tr key={f.inspection_no}>
                      <td className="mono small">{f.inspection_no}</td>
                      <td><span className={`tag ${f.inspection_type === 'IQC' ? 'tag-amber' : 'tag-purple'}`}>{f.inspection_type}</span></td>
                      <td>
                        {f.lot_no ? <Link to={`/genealogy?lot=${f.lot_no}`} className="mono small" style={{ color: '#9dc4ff' }}>{f.lot_no}</Link> : <span className="faint">—</span>}
                      </td>
                      <td className="small">{f.item}</td>
                      <td className="num" style={{ color: 'var(--danger)' }}>{f.measured_value}</td>
                      <td className="num faint small">{f.lower_limit}~{f.upper_limit}</td>
                      <td className="small faint">{time(f.inspected_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="scroll" style={{ maxHeight: 520 }}>
              <table className="data">
                <thead><tr><th>批次</th><th>物料</th><th>工序</th><th>可疑原因</th></tr></thead>
                <tbody>
                  {data.suspect_lots.map((s) => (
                    <tr key={s.lot_no}>
                      <td><Link to={`/genealogy?lot=${s.lot_no}`} className="mono small" style={{ color: '#ff9993' }}>{s.lot_no}</Link></td>
                      <td className="small">{s.material_name}</td>
                      <td><StageTag stage={s.stage} /></td>
                      <td className="small muted">{s.suspect_reason}</td>
                    </tr>
                  ))}
                  {!data.suspect_lots.length && <tr><td colSpan={4} className="faint">无</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div>
          <Card title="不合格项分布">
            {['含铁量Fe(%)', '活塞孔位置度(mm)', '密封面平面度(mm)', '泄漏率(mL/min)', '毛坯硬度HB'].map((item) => {
              const row = byItem.get(item);
              const max = Math.max(...[...byItem.values()].map((x) => x.fails), 1);
              return (
                <div key={item} style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                    <span>{item}</span>
                    <span className="num faint">{row?.fails ?? 0} 不合格</span>
                  </div>
                  <div className="bar" style={{ height: 7 }}>
                    <i style={{ width: `${((row?.fails ?? 0) / max) * 100}%`, background: 'var(--danger)' }} />
                  </div>
                </div>
              );
            })}
          </Card>

          <Card title="不合格波及估算" hint="系统自动展开下游成品、发货与客户">
            {[...failRows].filter((f) => f.lot_no).sort((a, b) => (b.impact?.shipped_qty ?? 0) - (a.impact?.shipped_qty ?? 0)).slice(0, 6).map((f) => (
              <div key={f.inspection_no} style={{ padding: '9px 0', borderBottom: '1px solid rgba(42,53,70,.5)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="mono small">{f.lot_no}</span>
                  <span className="faint small">{f.item}</span>
                  <span className="tag tag-red" style={{ marginLeft: 'auto' }}>{f.measured_value} 超限</span>
                </div>
                {f.impact ? (
                  <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 11.5 }}>
                    <span className="faint">成品 <b className="mono" style={{ color: 'var(--text)' }}>{f.impact.finished_lots}</b> 批</span>
                    <span className="faint">已发 <b className="mono" style={{ color: '#ffc061' }}>{qty(Math.round(f.impact.shipped_qty))}</b> 件</span>
                    <span className="faint">客户 <b className="mono" style={{ color: 'var(--text)' }}>{f.impact.customers.length}</b></span>
                    <Link to={`/forward?lot=${f.lot_no}`} style={{ color: '#9dc4ff', marginLeft: 'auto' }}>展开 →</Link>
                  </div>
                ) : <div className="small faint" style={{ marginTop: 5 }}>该批次无下游记录</div>}
              </div>
            ))}
          </Card>
        </div>
      </div>
    </>
  );
}
