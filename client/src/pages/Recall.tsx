import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type Complaint } from '../api';
import type { RecallPlan } from '../../../shared/types';
import { Card, Empty, ErrorBox, Loading, Stat, qty, time, money } from '../components/ui';

const PRIORITY: Record<string, { cls: string; label: string }> = {
  A: { cls: 'tag-red', label: 'A 级 · 立即召回' },
  B: { cls: 'tag-amber', label: 'B 级 · 计划换件' },
  C: { cls: 'tag-gray', label: 'C 级 · 观察' }
};

export default function Recall() {
  const [params, setParams] = useSearchParams();
  const [input, setInput] = useState(params.get('lot') ?? '');
  const [plan, setPlan] = useState<RecallPlan | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [complaint, setComplaint] = useState<Complaint | null>(null);
  const [expand, setExpand] = useState<string | null>(null);
  const [conservative, setConservative] = useState(true);

  useEffect(() => {
    api.complaint().then((c) => {
      setComplaint(c);
      const initial = c?.heat_lot ?? params.get('lot');
      if (initial) { setInput(initial); run(initial); }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (value: string) => {
    if (!value.trim()) return;
    setLoading(true);
    setError('');
    try {
      const r = await api.recall({ lot: value.trim().toUpperCase() });
      setPlan(r);
      setParams((p) => { p.set('lot', value.trim().toUpperCase()); return p; });
    } catch (e) {
      setError((e as Error).message);
      setPlan(null);
    } finally {
      setLoading(false);
    }
  };

  const totalQty = plan ? (conservative ? plan.total_conservative_qty : plan.total_affected_qty) : 0;
  const totalCost = plan ? (conservative ? plan.cost_estimate.total : plan.cost_attributable) : 0;

  return (
    <>
      <div className="section-head">
        <h2>召回模拟</h2>
        <p>给定原料批次或成品序列号，估算需召回件数、涉及发货单、拦截库存与召回成本</p>
      </div>

      <Card>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <input
            className="input input-lg mono" style={{ width: 380 }}
            placeholder="原料批次号，如 H-2509-014"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') run(input); }}
          />
          <button className="btn btn-primary" onClick={() => run(input)} disabled={loading}>{loading ? '模拟中…' : '运行召回模拟'}</button>
          {complaint && <button className="btn" onClick={() => { setInput(complaint.heat_lot); run(complaint.heat_lot); }}>载入投诉炉号</button>}
          <div className="spacer" />
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--text-dim)', cursor: 'pointer' }}>
            <input type="checkbox" checked={conservative} onChange={(e) => setConservative(e.target.checked)} />
            保守口径：召回受影响成品批次全部已发货（安全件默认）
          </label>
        </div>
      </Card>

      {error && <div style={{ marginTop: 16 }}><ErrorBox error={error} /></div>}
      {!plan && !loading && !error && <div style={{ marginTop: 16 }}><Card><Empty>输入批次号运行召回模拟</Empty></Card></div>}

      {plan && (
        <>
          <div className="grid cols-4" style={{ marginTop: 16 }}>
            <Stat label="需召回件数" value={qty(Math.round(totalQty))} sub={conservative ? `整批口径（精确折算 ${qty(plan.total_affected_qty, 1)} 件）` : `按投入贡献折算（整批 ${qty(plan.total_conservative_qty)} 件）`} tone="danger" />
            <Stat label="涉及发货单" value={plan.shipments.length} sub={`${plan.shipments.filter((s) => s.priority === 'A').length} 张 A 级`} />
            <Stat label="可拦截库存" value={qty(Math.round(conservative ? plan.in_stock_qty : plan.in_stock_attributable_qty))} sub={`${plan.blocked_inventory.length} 个成品批次 · 已发 ${qty(plan.total_shipped_qty)} 件`} tone="ok" />
            <Stat label="召回成本估算" value={money(totalCost)} sub={conservative ? `精确口径 ${money(plan.cost_attributable)}` : `整批口径 ${money(plan.cost_estimate.total)}`} tone="warn" />
          </div>

          <div className="split-wide" style={{ marginTop: 16 }}>
            <Card title="涉及发货单" hint="A 级：30 天内发出；B 级：90 天内；C 级：更早">
              {plan.shipments.length === 0 ? <Empty>该批次尚未发货，全部可拦截</Empty> : (
                <div className="scroll" style={{ maxHeight: 460 }}>
                  <table className="data">
                    <thead>
                      <tr><th>发货单</th><th>客户 / 目的地</th><th>发货日</th><th className="num">受影响</th><th className="num">整批</th><th>等级</th><th></th></tr>
                    </thead>
                    <tbody>
                      {plan.shipments.map((s) => (
                        <tr key={s.shipment_no}>
                          <td className="mono small">{s.shipment_no}</td>
                          <td>
                            <div className="small">{s.customer_name}</div>
                            <div className="faint" style={{ fontSize: 10.5 }}>{s.destination}</div>
                          </td>
                          <td className="small faint">{time(s.ship_date)}<div style={{ fontSize: 10 }}>{s.days_since_ship} 天前</div></td>
                          <td className="num" style={{ color: '#ff9993' }}>{qty(Math.round(conservative ? s.lot_qty : s.affected_qty))}</td>
                          <td className="num faint">{qty(s.lot_qty)}</td>
                          <td><span className={`tag ${PRIORITY[s.priority].cls}`}>{s.priority}</span></td>
                          <td>
                            <button className="btn btn-sm" onClick={() => setExpand(expand === s.shipment_no ? null : s.shipment_no)}>
                              {expand === s.shipment_no ? '收起' : '明细'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {expand && (() => {
                    const s = plan.shipments.find((x) => x.shipment_no === expand);
                    if (!s) return null;
                    return (
                      <div style={{ marginTop: 10, padding: 12, background: 'var(--bg-soft)', borderRadius: 8 }}>
                        <div className="small faint" style={{ marginBottom: 8 }}>{s.shipment_no} 的批次构成</div>
                        {s.lots.map((l) => (
                          <div key={l.lot_no} style={{ display: 'flex', gap: 10, fontSize: 11.5, padding: '3px 0' }}>
                            <span className="mono">{l.lot_no}</span>
                            <span className="faint">整批 {qty(l.qty)}</span>
                            <span className="faint">占比 {(l.fraction * 100).toFixed(1)}%</span>
                            <span className="mono" style={{ marginLeft: 'auto', color: '#ffc061' }}>受影响 {qty(l.attributable, 1)}</span>
                          </div>
                        ))}
                        <div className="small faint" style={{ marginTop: 10 }}>
                          序列号 ({s.serials.length})： <span className="mono" style={{ fontSize: 11 }}>{s.serials.slice(0, 8).join(', ')}{s.serials.length > 8 ? ` … +${s.serials.length - 8}` : ''}</span>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </Card>

            <div>
              <Card title="召回成本拆解">
                {(() => {
                  const c = conservative ? plan.cost_estimate : {
                    ...plan.cost_estimate,
                    freight: Math.round(plan.total_affected_qty * 42),
                    rework: Math.round((plan.total_affected_qty + plan.in_stock_attributable_qty) * 85),
                    scrap: 0,
                    total: plan.cost_attributable
                  };
                  const rows = [
                    { label: '物流（往返运费）', value: c.freight, color: '#4c9aff' },
                    { label: '检测与返修', value: c.rework, color: '#a78bfa' },
                    { label: '报废损失', value: c.scrap, color: '#ff5f56' }
                  ];
                  const max = Math.max(...rows.map((r) => r.value), 1);
                  return (
                    <>
                      {rows.map((r) => (
                        <div key={r.label} style={{ marginBottom: 13 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
                            <span>{r.label}</span><span className="mono">{money(r.value)}</span>
                          </div>
                          <div className="bar" style={{ height: 7 }}><i style={{ width: `${(r.value / max) * 100}%`, background: r.color }} /></div>
                        </div>
                      ))}
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                        <span style={{ fontWeight: 600 }}>合计</span>
                        <span className="mono" style={{ fontSize: 17, fontWeight: 650, color: '#ffc061' }}>{money(c.total)}</span>
                      </div>
                      <div className="faint small" style={{ marginTop: 8 }}>
                        当前为{conservative ? '保守（整批）' : '精确折算'}口径；单件制造成本基数 {money(c.unit_recall_cost)}，运费 {money(42)}/件 + 返修 {money(85)}/件
                      </div>
                    </>
                  );
                })()}
              </Card>

              <Card title="未发货库存拦截" hint="可直接就地冻结">
                {plan.blocked_inventory.length === 0 ? <Empty>无可拦截库存</Empty> : (
                  <table className="data">
                    <thead><tr><th>批次</th><th>物料</th><th>库位</th><th className="num">数量</th></tr></thead>
                    <tbody>
                      {plan.blocked_inventory.map((b) => (
                        <tr key={b.lot_no}>
                          <td className="mono small">{b.lot_no}</td>
                          <td className="small">{b.material_name}</td>
                          <td className="faint small">{b.location}</td>
                          <td className="num">{qty(b.qty, 1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>

              <Card title="可疑批次">
                <div className="faint small" style={{ marginBottom: 8 }}>共 {plan.suspect_lots.length} 个批次被标记为可疑</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {plan.suspect_lots.slice(0, 30).map((l) => (
                    <span key={l} className="tag tag-red mono" style={{ fontSize: 10.5 }}>{l}</span>
                  ))}
                  {plan.suspect_lots.length > 30 && <span className="faint small">+{plan.suspect_lots.length - 30} 更多</span>}
                </div>
              </Card>
            </div>
          </div>
        </>
      )}
      {loading && <Loading text="正在模拟召回范围…" />}
    </>
  );
}
