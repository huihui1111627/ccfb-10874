import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type Complaint } from '../api';
import type { ForwardTrace } from '../../../shared/types';
import { Card, Empty, ErrorBox, FlowTag, Loading, StageTag, Stat, qty, time } from '../components/ui';

export default function Forward() {
  const [params, setParams] = useSearchParams();
  const [lot, setLot] = useState(params.get('lot') ?? '');
  const [data, setData] = useState<ForwardTrace | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [complaint, setComplaint] = useState<Complaint | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    api.complaint().then((c) => {
      setComplaint(c);
      const initial = c?.heat_lot ?? params.get('lot');
      if (initial) {
        setLot(initial);
        run(initial);
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (value: string) => {
    if (!value.trim()) return;
    setLoading(true);
    setError('');
    try {
      const r = await api.forward(value.trim().toUpperCase());
      setData(r);
      setParams((p) => { p.set('lot', value.trim().toUpperCase()); return p; });
    } catch (e) {
      setError((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  const maxFrac = Math.max(...(data?.finished_lots.map((f) => (f as ForwardTrace['finished_lots'][number] & { fraction?: number }).fraction ?? 0) ?? [1]), 0.0001);

  return (
    <>
      <div className="section-head">
        <h2>正向追溯：原料 → 成品 → 客户</h2>
        <p>给定一个原料批次，沿谱系展开全部下游在制、成品、发货单与客户，按数量占比折算受影响当量</p>
      </div>

      <Card>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <input
            className="input input-lg mono" style={{ width: 360 }}
            placeholder="原料批次号，如 H-2509-014"
            value={lot}
            onChange={(e) => setLot(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') run(lot); }}
          />
          <button className="btn btn-primary" onClick={() => run(lot)} disabled={loading}>{loading ? '追溯中…' : '开始正向追溯'}</button>
          {complaint && (
            <button className="btn" onClick={() => { setLot(complaint.heat_lot); run(complaint.heat_lot); }}>
              载入投诉炉号 {complaint.heat_lot}
            </button>
          )}
        </div>
      </Card>

      {error && <div style={{ marginTop: 16 }}><ErrorBox error={error} /></div>}
      {!data && !loading && !error && <div style={{ marginTop: 16 }}><Card><Empty>输入原料批次号开始追溯</Empty></Card></div>}

      {data && (
        <>
          <div className="grid cols-4" style={{ marginTop: 16 }}>
            <Stat label="下游批次数" value={qty(data.nodes.length)} sub={`其中成品 ${data.finished_lots.length} 个`} />
            <Stat label="受影响成品当量" value={qty(data.totals.finished_qty, 1)} sub="按投入占比折算" tone="blue" />
            <Stat label="已发货" value={qty(data.totals.shipped_qty, 1)} sub={`库存 ${qty(data.totals.in_stock_qty, 1)} 件`} tone="warn" />
            <Stat label="涉及客户" value={data.totals.customers} sub={`追溯耗时 ${data.elapsed_ms}ms`} tone={data.totals.customers > 0 ? 'danger' : 'ok'} />
          </div>

          <div className="split-wide" style={{ marginTop: 16 }}>
            <Card title="受影响的发货单与客户" hint="数量为按批次贡献比例折算的当量">
              {data.affected_customers.length === 0 ? <Empty>该批次尚未流入客户</Empty> : (
                <table className="data">
                  <thead><tr><th>客户</th><th className="num">受影响当量</th><th className="num">发货单</th><th style={{ width: '22%' }}>占比</th></tr></thead>
                  <tbody>
                    {data.affected_customers.filter((c) => c.qty >= 1).map((c) => (
                      <tr key={c.code}>
                        <td>{c.name} <span className="faint mono small">{c.code}</span></td>
                        <td className="num">{qty(c.qty, 1)}</td>
                        <td className="num">{c.shipments}</td>
                        <td><div className="bar"><i style={{ width: `${(c.qty / Math.max(...data.affected_customers.filter((x) => x.qty >= 1).map((x) => x.qty), 1)) * 100}%`, background: '#ff8f88' }} /></div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="small faint" style={{ marginTop: 14, marginBottom: 6 }}>具体发货单</div>
              <div className="scroll-y" style={{ maxHeight: 240 }}>
                <table className="data">
                  <thead><tr><th>发货单</th><th>客户</th><th>日期</th><th className="num">受影响</th></tr></thead>
                  <tbody>
                    {data.finished_lots.filter((f) => !(f as unknown as { minor?: boolean }).minor).flatMap((f) => f.shipments).filter((s) => s.qty >= 1).filter((s, i, arr) => arr.findIndex((x) => x.shipment_no === s.shipment_no) === i).map((s) => (
                      <tr key={s.shipment_no}>
                        <td className="mono">{s.shipment_no}</td>
                        <td className="small">{s.customer_name}</td>
                        <td className="small faint">{time(s.ship_date)}</td>
                        <td className="num">{qty(s.qty, 1)}</td>
                      </tr>
                    ))}
                    {!data.finished_lots.some((f) => f.shipments.length) && <tr><td colSpan={4} className="faint">无发货记录</td></tr>}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card title="谱系展开路径" hint={`${data.nodes.length} 个节点，点击查看成品明细`}>
              <div className="scroll-y" style={{ maxHeight: 420 }}>
                {data.nodes.map((n, i) => {
                  const isFin = n.stage === 'FINAL';
                  const fin = data.finished_lots.find((f) => f.lot_no === n.lot_no);
                  return (
                    <div key={i}>
                      <div
                        onClick={() => isFin && setExpanded(expanded === n.lot_no ? null : n.lot_no)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 9, padding: '7px 8px', borderRadius: 6,
                          marginLeft: n.depth * 10, cursor: isFin ? 'pointer' : 'default',
                          background: expanded === n.lot_no ? 'rgba(76,154,255,.09)' : n.suspect ? 'rgba(255,95,86,.06)' : undefined
                        }}
                      >
                        <span className="faint mono" style={{ width: 22, fontSize: 10 }}>L{n.depth}</span>
                        <StageTag stage={n.stage} />
                        <span className="mono" style={{ color: n.suspect ? '#ff9993' : undefined }}>{n.lot_no}</span>
                        <span className="faint small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.material_name}</span>
                        {n.flow_type !== 'NORMAL' && <FlowTag flow={n.flow_type} />}
                        <span className="mono faint small" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                          {qty(n.qty_produced, 0)} {fin ? `· 影响 ${qty(fin.attributable_qty, 0)}` : ''}
                        </span>
                        {isFin && <span className="faint" style={{ fontSize: 10 }}>{expanded === n.lot_no ? '▾' : '▸'}</span>}
                      </div>
                      {expanded === n.lot_no && fin && (
                        <div style={{ marginLeft: n.depth * 10 + 34, padding: '8px 10px', borderLeft: '2px solid rgba(76,154,255,.35)', marginBottom: 6 }}>
                          <div className="kv" style={{ gridTemplateColumns: '86px 1fr', fontSize: 11.5 }}>
                            <dt>贡献比例</dt><dd className="mono">{((fin as unknown as { fraction: number }).fraction * 100).toFixed(1)}%</dd>
                            <dt>该批产量</dt><dd className="mono">{qty(fin.qty_produced)} 件</dd>
                            <dt>折算当量</dt><dd className="mono">{qty(fin.attributable_qty, 1)} 件</dd>
                          </div>
                          {fin.shipments.map((s) => (
                            <div key={s.shipment_no} className="small" style={{ marginTop: 6, color: 'var(--text-dim)' }}>
                              → {s.shipment_no} · {s.customer_name} · {time(s.ship_date)} · {qty(s.qty, 1)} 件
                              <span className="faint"> ({s.serials.length} 个序列号)</span>
                            </div>
                          ))}
                          {!fin.shipments.length && <div className="small faint" style={{ marginTop: 6 }}>仍在库存，可直接拦截</div>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>

          <Card
            title="成品批次明细"
            hint="按贡献比例排序"
            actions={<Link className="btn btn-sm" to={`/recall?lot=${data.raw_lot}`}>用该批次做召回模拟</Link>}
          >
            <div className="scroll" style={{ maxHeight: 340 }}>
              <table className="data">
                <thead>
                  <tr><th>成品批次</th><th className="num">产量</th><th className="num">贡献占比</th><th style={{ width: '18%' }}></th><th className="num">折算当量</th><th>发货单</th><th>状态</th></tr>
                </thead>
                <tbody>
                  {[...data.finished_lots].sort((a, b) => b.attributable_qty - a.attributable_qty).filter((f) => !(f as unknown as { minor?: boolean }).minor).map((f) => (
                    <tr key={f.lot_no}>
                      <td className="mono">{f.lot_no}</td>
                      <td className="num">{qty(f.qty_produced)}</td>
                      <td className="num">{(((f as unknown as { fraction: number }).fraction) * 100).toFixed(1)}%</td>
                      <td><div className="bar"><i style={{ width: `${(((f as unknown as { fraction: number }).fraction) / maxFrac) * 100}%` }} /></div></td>
                      <td className="num">{qty(f.attributable_qty, 1)}</td>
                      <td className="small">{f.shipments.map((s) => s.shipment_no).join(', ') || '—'}</td>
                      <td>{f.shipments.length ? <span className="tag tag-amber">已发货</span> : <span className="tag tag-green">库存</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
      {loading && <Loading text="正在沿谱系展开…" />}
    </>
  );
}
