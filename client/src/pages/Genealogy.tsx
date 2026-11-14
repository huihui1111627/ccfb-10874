import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type GenealogyData, type LotDetail, type LotRow } from '../api';
import { Card, Empty, ErrorBox, FlowTag, Loading, StageTag, qty, time } from '../components/ui';

const STAGE_COLOR: Record<string, string> = {
  CAST: '#f5a623', MACH: '#4c9aff', ASSY: '#a78bfa', FINAL: '#35c98a'
};
const STAGE_LABEL: Record<string, string> = { CAST: '熔炼铸造', MACH: '机加', ASSY: '装配', FINAL: '成品' };
const LANE_H = 118;

export default function Genealogy() {
  const [params, setParams] = useSearchParams();
  const lot = params.get('lot') ?? '';
  const [q, setQ] = useState('');
  const [dir, setDir] = useState<'both' | 'forward' | 'backward'>('both');
  const [data, setData] = useState<GenealogyData | null>(null);
  const [detail, setDetail] = useState<LotDetail | null>(null);
  const [candidates, setCandidates] = useState<LotRow[]>([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    api.lots('', '').then((r) => setCandidates(r.rows)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!lot) { setData(null); setDetail(null); return; }
    setError('');
    api.genealogy(lot, dir, 10).then(setData).catch((e) => setError(e.message));
    api.lot(lot).then(setDetail).catch(() => setDetail(null));
  }, [lot, dir]);

  const layout = useMemo(() => {
    if (!data) return null;
    const byStage = new Map<string, GenealogyData['nodes']>();
    for (const n of data.nodes) {
      const arr = byStage.get(n.stage) ?? [];
      arr.push(n);
      byStage.set(n.stage, arr);
    }
    const lanes = ['CAST', 'MACH', 'ASSY', 'FINAL']
      .filter((s) => byStage.has(s))
      .map((s) => ({
        stage: s,
        label: STAGE_LABEL[s],
        nodes: (byStage.get(s) ?? []).sort((a, b) => {
          // 同一工段内原料批置顶，其余按时间排序，减少跨列连线缠绕
          if (a.is_raw !== b.is_raw) return a.is_raw ? -1 : 1;
          return (a.production_date + a.lot_no).localeCompare(b.production_date + b.lot_no);
        })
      }));
    // 每列宽 168，按每道最多节点数决定高度
    const colW = 168;
    const maxPerLane = Math.max(...lanes.map((l) => l.nodes.length), 1);
    const bodyH = Math.min(maxPerLane * LANE_H, 780);
    const positions = new Map<string, { x: number; y: number; w: number; h: number; lane: string }>();
    lanes.forEach((lane, li) => {
      const n = lane.nodes.length;
      const h = Math.max(46, Math.min(LANE_H - 16, bodyH / Math.max(n, 1) - 10));
      const gap = n > 1 ? (bodyH - n * h) / (n - 1) : 0;
      lane.nodes.forEach((node, ni) => {
        positions.set(node.lot_no, {
          x: li * colW, y: n > 1 ? ni * (h + gap) : bodyH / 2 - h / 2, w: colW - 34, h, lane: lane.stage
        });
      });
    });
    return { lanes, positions, width: lanes.length * colW, height: bodyH, colW };
  }, [data]);

  const submit = (value: string) => {
    setParams((p) => { p.set('lot', value); return p; });
    setSelected(null);
  };

  const filteredCandidates = candidates
    .filter((c) => !q || c.lot_no.toUpperCase().includes(q.toUpperCase()) || c.material_name.includes(q))
    .slice(0, 60);

  return (
    <>
      <div className="section-head">
        <h2>批次谱系图</h2>
        <p>从原料到成品的有向图，支持拆批 / 合批 / 返工 / 报废多分支</p>
      </div>

      <Card>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <input
            className="input input-lg mono" style={{ width: 340 }}
            placeholder="输入批次号，如 H-2509-014 / F20250916009"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) submit(q.trim().toUpperCase()); }}
          />
          <button className="btn btn-primary" onClick={() => q.trim() && submit(q.trim().toUpperCase())}>查看谱系</button>
          <div className="spacer" />
          <select className="select" value={dir} onChange={(e) => setDir(e.target.value as typeof dir)}>
            <option value="both">上下游全部</option>
            <option value="forward">仅下游</option>
            <option value="backward">仅上游</option>
          </select>
        </div>
        {!lot && (
          <div style={{ marginTop: 14 }}>
            <div className="small faint" style={{ marginBottom: 8 }}>快速选择（点击查看）</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {filteredCandidates.slice(0, 24).map((c) => (
                <button key={c.lot_no} className="btn btn-sm" onClick={() => submit(c.lot_no)} title={c.material_name}>
                  <span className="mono">{c.lot_no}</span>
                  <span className="faint" style={{ marginLeft: 6 }}>{c.material_name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>

      {error && <div style={{ marginTop: 16 }}><ErrorBox error={error} /></div>}
      {!lot && !error && <div style={{ marginTop: 16 }}><Card><Empty>输入批次号或从上方快速选择，查看其上下游谱系</Empty></Card></div>}

      {lot && data && layout && (
        <>
          <div className="split-wide" style={{ marginTop: 16 }}>
            <Card title="谱系拓扑" hint={`聚焦 ${data.focus} · ${data.nodes.length} 个批次 / ${data.edges.length} 条流转`}>
              <div className="scroll" style={{ paddingBottom: 4 }}>
                <div style={{ position: 'relative', width: layout.width, height: layout.height + 34, minWidth: '100%' }}>
                  {layout.lanes.map((lane, li) => (
                    <div key={lane.stage} style={{
                      position: 'absolute', left: li * layout.colW, top: 0, width: layout.colW - 34,
                      display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 6
                    }}>
                      <span style={{ width: 6, height: 6, borderRadius: 3, background: STAGE_COLOR[lane.stage] }} />
                      <span className="small" style={{ fontWeight: 550 }}>{lane.label}</span>
                      <span className="faint small">{lane.nodes.length}</span>
                    </div>
                  ))}
                  <svg style={{ position: 'absolute', left: 0, top: 26, pointerEvents: 'none' }} width={layout.width} height={layout.height}>
                    {data.edges.map((e, i) => {
                      const p = layout.positions.get(e.parent);
                      const c = layout.positions.get(e.child);
                      if (!p || !c) return null;
                      const x1 = p.x + p.w, y1 = p.y + p.h / 2;
                      const x2 = c.x, y2 = c.y + c.h / 2;
                      const isRework = e.flow_type === 'REWORK';
                      const active = selected === e.parent || selected === e.child;
                      const mx = (x1 + x2) / 2;
                      return (
                        <path
                          key={i}
                          d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                          fill="none"
                          stroke={isRework ? '#f5a623' : active ? '#4c9aff' : 'rgba(120,145,180,.32)'}
                          strokeWidth={active ? 2 : 1.2}
                          strokeDasharray={isRework ? '4 3' : undefined}
                        />
                      );
                    })}
                  </svg>
                  {data.nodes.map((n) => {
                    const p = layout.positions.get(n.lot_no);
                    if (!p) return null;
                    const color = STAGE_COLOR[n.stage];
                    const isFocus = n.is_focus;
                    const isSel = selected === n.lot_no;
                    return (
                      <div
                        key={n.lot_no}
                        onClick={() => { setSelected(n.lot_no); submit(n.lot_no); }}
                        title={`${n.material_name} · ${qty(n.qty_produced)}${n.material_code === 'AL-ADC12' ? 'kg' : '件'}`}
                        style={{
                          position: 'absolute', left: p.x, top: 26 + p.y, width: p.w, height: p.h,
                          background: n.suspect ? 'rgba(255,95,86,.12)' : isFocus ? 'rgba(76,154,255,.16)' : 'var(--panel-2)',
                          border: `1px solid ${isFocus ? '#4c9aff' : isSel ? '#7fb4ff' : n.suspect ? 'rgba(255,95,86,.55)' : 'var(--border)'}`,
                          borderLeft: `3px solid ${color}`,
                          borderRadius: 6, padding: '5px 8px', cursor: 'pointer', overflow: 'hidden',
                          display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2,
                          boxShadow: isFocus ? '0 0 0 3px rgba(76,154,255,.12)' : undefined
                        }}
                      >
                        <div className="mono" style={{ fontSize: 11, color: n.suspect ? '#ff9993' : '#cfe0f5', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {n.lot_no}
                        </div>
                        <div className="faint" style={{ fontSize: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {n.material_name}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap' }} className="faint small">
                <span><i style={{ display: 'inline-block', width: 18, height: 2, background: 'rgba(120,145,180,.6)', verticalAlign: 'middle' }} /> 正常流转</span>
                <span><i style={{ display: 'inline-block', width: 18, height: 2, borderTop: '2px dashed #f5a623', verticalAlign: 'middle' }} /> 返工</span>
                <span><i style={{ display: 'inline-block', width: 10, height: 10, background: 'rgba(255,95,86,.25)', border: '1px solid rgba(255,95,86,.55)', verticalAlign: 'middle' }} /> 可疑批次</span>
              </div>
            </Card>

            <div>
              {detail && (
                <Card title="批次详情" hint={detail.lot.lot_no}>
                  <dl className="kv">
                    <dt>物料</dt><dd>{detail.lot.material_name} <span className="faint mono">{detail.lot.material_code}</span></dd>
                    <dt>工序</dt><dd><StageTag stage={detail.lot.stage} /></dd>
                    <dt>产出 / 结存</dt><dd className="mono">{qty(detail.lot.qty_produced, 2)} {detail.lot.uom} <span className="faint">/ 结存 {qty(detail.lot.qty_remaining, 2)}</span></dd>
                    <dt>生产日期</dt><dd className="mono">{detail.lot.production_date}</dd>
                    <dt>工单</dt><dd className="mono">{detail.lot.work_order || '—'}</dd>
                    {detail.lot.supplier && (<><dt>供应商</dt><dd>{detail.lot.supplier}</dd></>)}
                    {detail.lot.suspect ? (<><dt>状态</dt><dd><span className="tag tag-red">可疑</span> <span className="faint small">{detail.lot.suspect_reason}</span></dd></>) : null}
                  </dl>
                  <div className="small faint" style={{ margin: '14px 0 6px' }}>上游投入 {detail.parents.length} 条</div>
                  <div className="scroll-y" style={{ maxHeight: 130 }}>
                    {detail.parents.slice(0, 12).map((p, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: '1px solid rgba(42,53,70,.5)' }}>
                        <button className="mono small" style={{ background: 'none', border: 'none', color: '#9dc4ff', padding: 0 }} onClick={() => submit(p.parent_lot)}>{p.parent_lot}</button>
                        <span className="faint small" style={{ marginLeft: 'auto' }}>{qty(p.qty_consumed, 1)}</span>
                        <FlowTag flow={p.flow_type} />
                      </div>
                    ))}
                    {!detail.parents.length && <div className="faint small">无（原料批次）</div>}
                  </div>
                  <div className="small faint" style={{ margin: '14px 0 6px' }}>下游产出 {detail.children.length} 条</div>
                  <div className="scroll-y" style={{ maxHeight: 130 }}>
                    {detail.children.slice(0, 12).map((c, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: '1px solid rgba(42,53,70,.5)' }}>
                        <button className="mono small" style={{ background: 'none', border: 'none', color: '#9dc4ff', padding: 0 }} onClick={() => submit(c.child_lot)}>{c.child_lot}</button>
                        <span className="faint small" style={{ marginLeft: 'auto' }}>{qty(c.qty_consumed, 1)}</span>
                        <FlowTag flow={c.flow_type} />
                      </div>
                    ))}
                    {!detail.children.length && <div className="faint small">无（末端批次）</div>}
                  </div>
                </Card>
              )}
              {detail && detail.inspections.length > 0 && (
                <Card title="质检记录" hint={`${detail.inspections.length} 条`}>
                  <table className="data">
                    <thead><tr><th>检验单</th><th>项目</th><th className="num">实测</th><th>结果</th></tr></thead>
                    <tbody>
                      {detail.inspections.map((x) => (
                        <tr key={x.inspection_no}>
                          <td className="mono small">{x.inspection_no}</td>
                          <td className="small">{x.item}</td>
                          <td className="num">{x.measured_value}</td>
                          <td><span className={`tag ${x.result === 'FAIL' ? 'tag-red' : 'tag-green'}`}>{x.result}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              )}
              {detail && detail.shipments.length > 0 && (
                <Card title="发货记录">
                  {detail.shipments.map((s, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, padding: '5px 0', borderBottom: '1px solid rgba(42,53,70,.5)' }}>
                      <span className="mono small">{s.shipment_no}</span>
                      <span className="small muted">{s.customer_name}</span>
                      <span className="faint small" style={{ marginLeft: 'auto' }}>{time(s.ship_date)} · {qty(s.qty)} 件</span>
                    </div>
                  ))}
                </Card>
              )}
            </div>
          </div>
        </>
      )}
      {lot && !data && !error && <Loading />}
    </>
  );
}
