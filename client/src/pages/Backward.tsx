import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type Complaint, type LotRow } from '../api';
import type { BackwardTrace, TraceHop } from '../../../shared/types';
import { Card, Empty, ErrorBox, FlowTag, Loading, StageTag, Stat, qty, time } from '../components/ui';

export default function Backward() {
  const [params, setParams] = useSearchParams();
  const [mode, setMode] = useState<'serial' | 'lot'>('serial');
  const [query, setQuery] = useState(params.get('serial') ?? '');
  const [data, setData] = useState<BackwardTrace | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [complaint, setComplaint] = useState<Complaint | null>(null);
  const [finLots, setFinLots] = useState<LotRow[]>([]);
  const [openHop, setOpenHop] = useState<string | null>(null);

  useEffect(() => {
    api.complaint().then((c) => {
      setComplaint(c);
      const initial = c?.serials[0] ?? params.get('serial');
      if (initial) { setQuery(initial); run(initial, 'serial'); }
    }).catch(() => {});
    api.lots('', 'FINAL').then((r) => setFinLots(r.rows.slice(0, 30))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (value: string, m: 'serial' | 'lot' = mode) => {
    if (!value.trim()) return;
    setLoading(true);
    setError('');
    try {
      const body = m === 'serial' ? { serial: value.trim().toUpperCase() } : { lot: value.trim().toUpperCase() };
      const r = await api.backward(body);
      setData(r);
      setParams((p) => { if (m === 'serial') { p.set('serial', value.trim().toUpperCase()); } else { p.set('lot', value.trim().toUpperCase()); } return p; });
    } catch (e) {
      setError((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (m: 'serial' | 'lot') => {
    setMode(m);
    setQuery('');
    setData(null);
    setError('');
  };

  const paramRows = data?.hops.map((h) => ({ hop: h, keys: Object.entries(h.params) })) ?? [];
  const rawLots = data?.paths.filter((p) => p.weight > 0) ?? [];

  return (
    <>
      <div className="section-head">
        <h2>反向追溯：序列号 → 原料炉号 → 工艺参数</h2>
        <p>从任意成品序列号或成品批次出发，回溯全部投料批次、供应商、工序设备与工艺参数</p>
      </div>

      <Card>
        <div className="toolbar" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 4, background: 'var(--bg-soft)', padding: 3, borderRadius: 8, border: '1px solid var(--border)' }}>
            <button className={`btn btn-sm ${mode === 'serial' ? 'btn-primary' : ''}`} style={{ border: 'none' }} onClick={() => switchMode('serial')}>按序列号</button>
            <button className={`btn btn-sm ${mode === 'lot' ? 'btn-primary' : ''}`} style={{ border: 'none' }} onClick={() => switchMode('lot')}>按成品批次</button>
          </div>
          <input
            className="input input-lg mono" style={{ width: 380 }}
            placeholder={mode === 'serial' ? '序列号，如 FIN-20250916-05118' : '成品批次号，如 F20250916009'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') run(query); }}
          />
          <button className="btn btn-primary" onClick={() => run(query)} disabled={loading}>{loading ? '回溯中…' : '开始反向追溯'}</button>
          {complaint && mode === 'serial' && (
            <button className="btn" onClick={() => { setQuery(complaint.serials[0]); run(complaint.serials[0], 'serial'); }}>
              载入客户序列号
            </button>
          )}
        </div>
        {mode === 'lot' && finLots.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {finLots.slice(0, 14).map((l) => (
              <button key={l.lot_no} className="btn btn-sm" onClick={() => { setQuery(l.lot_no); run(l.lot_no, 'lot'); }}>
                <span className="mono">{l.lot_no}</span>
              </button>
            ))}
          </div>
        )}
        {complaint && mode === 'serial' && (
          <div className="faint small" style={{ marginTop: 10 }}>
            客户投诉单 {complaint.complaint_no} 提供的序列号：{complaint.serials.join('、')}
          </div>
        )}
      </Card>

      {error && <div style={{ marginTop: 16 }}><ErrorBox error={error} /></div>}
      {!data && !loading && !error && <div style={{ marginTop: 16 }}><Card><Empty>输入序列号或成品批次号开始反查</Empty></Card></div>}

      {data && (
        <>
          <div className="grid cols-4" style={{ marginTop: 16 }}>
            <Stat label="追溯对象" value={<span className="mono" style={{ fontSize: 14 }}>{data.serial_no || data.lot_no}</span>} sub={data.serial_no ? `成品批次 ${data.lot_no}` : '成品批次'} />
            <Stat label="涉及原料批次" value={data.raw_lots.length} sub={rawLots.filter((p) => p.weight > 0.2).length + ' 个为主要贡献'} tone="blue" />
            <Stat label="工序环节" value={data.hops.length} sub={`追溯耗时 ${data.elapsed_ms}ms`} />
            <Stat label="发货去向" value={data.shipments.length ? data.shipments.map((s) => s.shipment_no).join(', ') : '库存'} sub={data.shipments[0]?.customer_name} tone={data.shipments.length ? 'warn' : 'ok'} />
          </div>

          <Card title="原料构成" hint="权重为该原料对本序列号的贡献比例">
            <div className="scroll">
              <table className="data">
                <thead><tr><th>原料批次</th><th>物料</th><th>供应商</th><th className="num">贡献权重</th><th style={{ width: '26%' }}>构成</th><th>状态</th></tr></thead>
                <tbody>
                  {rawLots.map((p) => (
                    <tr key={p.raw_lot}>
                      <td className="mono">{p.raw_lot}</td>
                      <td className="small">{p.material_name}</td>
                      <td className="small muted">{p.supplier ?? '—'}</td>
                      <td className="num">{(p.weight * 100).toFixed(1)}%</td>
                      <td><div className="bar"><i style={{ width: `${p.weight * 100}%`, background: p.raw_lot.startsWith('H-') ? '#f5a623' : '#a78bfa' }} /></div></td>
                      <td>{p.raw_lot === complaint?.heat_lot ? <span className="tag tag-red">投诉炉号</span> : <span className="tag tag-gray">正常</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="split" style={{ marginTop: 16 }}>
            <Card title="工艺路线与参数" hint="点击工序展开全部参数">
              {data.hops.map((h) => (
                <div key={h.op_id} style={{ marginBottom: 8 }}>
                  <div
                    onClick={() => setOpenHop(openHop === h.op_id ? null : h.op_id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px', borderRadius: 7,
                      background: openHop === h.op_id ? 'rgba(76,154,255,.08)' : 'var(--panel-2)',
                      border: '1px solid ' + (openHop === h.op_id ? 'rgba(76,154,255,.35)' : 'var(--border)'),
                      cursor: 'pointer'
                    }}
                  >
                    <StageTag stage={h.stage} />
                    <span className="small" style={{ fontWeight: 550 }}>{h.work_order}</span>
                    <span className="faint small">{h.equipment} · {h.operator}</span>
                    <FlowTag flow={h.flow_type} />
                    <span className="faint small" style={{ marginLeft: 'auto' }}>{time(h.event_time)}</span>
                  </div>
                  {openHop === h.op_id && (
                    <div style={{ padding: '8px 12px' }}>
                      <div className="small faint" style={{ marginBottom: 6 }}>投入</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                        {h.inputs.map((i) => (
                          <span key={i.lot_no} className={`tag ${i.role === 'MAIN' ? 'tag-blue' : i.role === 'BLEND' ? 'tag-amber' : 'tag-purple'}`}>
                            {i.lot_no} · {qty(i.qty, 1)} · {i.role === 'MAIN' ? '主料' : i.role === 'BLEND' ? '炉料' : '辅料'}
                          </span>
                        ))}
                      </div>
                      <div className="small faint" style={{ marginBottom: 6 }}>产出 / 报废</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                        {h.outputs.map((o) => (
                          <span key={o.lot_no} className="tag tag-green">{o.lot_no} · {qty(o.qty, 1)}</span>
                        ))}
                        {h.scrap_qty > 0 && <span className="tag tag-red">报废 {qty(h.scrap_qty, 2)}</span>}
                      </div>
                      <div className="small faint" style={{ marginBottom: 6 }}>工艺参数</div>
                      <div className="grid cols-2" style={{ gap: 4 }}>
                        {Object.entries(h.params).map(([k, v]) => (
                          <div key={k} style={{ display: 'flex', gap: 6, fontSize: 11.5 }}>
                            <span className="faint">{k}</span>
                            <span className="mono" style={{ marginLeft: 'auto' }}>{String(v)}</span>
                          </div>
                        ))}
                      </div>
                      {h.quality_flags.length > 0 && (
                        <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {h.quality_flags.map((f) => <span key={f} className="tag tag-amber">{f}</span>)}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </Card>

            <div>
              <Card title="关键参数对照" hint="全部工序参数横向汇总">
                <div className="scroll" style={{ maxHeight: 300 }}>
                  <table className="data">
                    <thead><tr><th>工序</th><th>参数</th><th className="num">数值</th></tr></thead>
                    <tbody>
                      {paramRows.flatMap(({ hop, keys }) => keys.map(([k, v], idx) => (
                        <tr key={hop.op_id + k}>
                          <td className="small faint">{idx === 0 ? hop.stage_name : ''}</td>
                          <td className="small">{k}</td>
                          <td className="num">{String(v)}</td>
                        </tr>
                      )))}
                    </tbody>
                  </table>
                </div>
              </Card>
              <Card title="完整追溯链路" hint="原料 → 成品">
                {rawLots.slice(0, 3).map((p) => (
                  <div key={p.raw_lot} style={{ marginBottom: 14 }}>
                    <div className="mono small" style={{ color: '#ffc061', marginBottom: 4 }}>{p.raw_lot} <span className="faint">({(p.weight * 100).toFixed(1)}%)</span></div>
                    {p.steps.map((s, i) => (
                      <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', paddingLeft: 10, borderLeft: '1px solid var(--border)', marginLeft: 4, paddingBottom: 4 }}>
                        <StageTag stage={s.stage} />
                        <span className="mono small">{s.lot_no}</span>
                        <span className="faint small">{s.equipment}</span>
                        <span className="faint" style={{ marginLeft: 'auto', fontSize: 10 }}>{time(s.event_time).slice(5, 16)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </Card>
            </div>
          </div>
        </>
      )}
      {loading && <Loading text="正在反向回溯…" />}
    </>
  );
}
