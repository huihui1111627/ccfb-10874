import { useEffect, useState } from 'react';
import { api } from '../api';
import { Card, ErrorBox, Loading, SeverityTag, Stat, qty } from '../components/ui';

type Status = Awaited<ReturnType<typeof api.ingestStatus>>;

const SEV_ORDER = { ERROR: 0, WARN: 1, INFO: 2 } as const;

export default function Ingest() {
  const [status, setStatus] = useState<Status | null>(null);
  const [validation, setValidation] = useState<Awaited<ReturnType<typeof api.validate>> | null>(null);
  const [showValidation, setShowValidation] = useState(false);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState<string>('ALL');
  const [lastRun, setLastRun] = useState<{ elapsed: number; runId: string } | null>(null);

  const load = () => {
    setError('');
    api.ingestStatus().then(setStatus).catch((e) => setError(e.message));
    api.validate().then(setValidation).catch(() => setValidation(null));
  };
  useEffect(load, []);

  const run = async () => {
    setRunning(true);
    setError('');
    try {
      const r = await api.runIngest();
      setLastRun({ elapsed: r.elapsed_ms, runId: r.run_id });
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  if (error && !status) return <ErrorBox error={error} />;
  if (!status) return <Loading />;

  const counts = ((status.run?.counts?.counts ?? status.run?.counts ?? {}) as Record<string, number>);
  const files = ((status.run?.counts?.files ?? (status.run as unknown as { files?: unknown[] })?.files ?? []) as { name: string; size: number; modified: string }[]);
  const timeStats = ((status.run?.counts?.time ?? (status.run as unknown as { time?: unknown[] })?.time ?? []) as { system: string; records: number; assumed_tz: string; fixed_formats: string[] }[]);
  const issues = status.issues.filter((i) => filter === 'ALL' || i.severity === filter);
  const sevCount = (s: string) => status.severity_counts.find((x) => x.severity === s)?.n ?? 0;

  const mappingBySystem = new Map<string, { raw: string; normalized: string; confidence: string }[]>();
  for (const m of status.mappings) {
    const arr = mappingBySystem.get(m.system) ?? [];
    if (!arr.some((x) => x.raw === m.raw && x.normalized === m.normalized)) arr.push(m);
    mappingBySystem.set(m.system, arr);
  }

  return (
    <>
      <div className="section-head">
        <h2>三系统数据接入与归一化</h2>
        <p>MES 工序记录 / WMS 出入库 / QMS 检验记录 → 统一批次、统一时间、统一物料编码</p>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat label="MES 工序记录" value={qty(counts.mes_rows ?? 0)} sub={`合并为 ${counts.mes_ops ?? 0} 个工序 · 去重 ${counts.mes_duplicates ?? 0} 行`} />
        <Stat label="WMS 出入库" value={qty(counts.wms_moves ?? 0)} sub={`${counts.shipments ?? 0} 张发货单 / ${counts.shipment_lines ?? 0} 行明细`} />
        <Stat label="QMS 检验记录" value={qty(counts.qms_inspections ?? 0)} sub="含 IQC / IPQC / FQC" />
        <Stat label="归一化结果" value={qty(counts.lots ?? 0)} sub={`${counts.edges ?? 0} 条谱系边 · ${counts.serials ?? 0} 个序列号`} tone="blue" />
      </div>

      <Card
        title="追溯结果自检"
        hint="与生成时保留的真实谱系逐批对照：谱系边、数量守恒、批次产出量、原料→序列号端到端"
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {validation && (
              <span className={`tag ${validation.ok ? 'tag-green' : 'tag-amber'}`}>
                {validation.ok ? '全部通过' : '存在偏差，需复核'}
              </span>
            )}
            <button className="btn btn-sm" onClick={() => setShowValidation((v) => !v)}>{showValidation ? '收起明细' : '展开明细'}</button>
          </div>
        }
      >
        {!validation ? <div className="faint small">暂无真值文件（data/truth/truth.json）</div> : (
          <>
            <div className="grid cols-4">
              <div>
                <div className="stat-label">谱系还原准确率</div>
                <div className="stat-value" style={{ fontSize: 20, color: validation.lineage.accuracy >= 0.98 ? 'var(--ok)' : 'var(--warn)' }}>
                  {(validation.lineage.accuracy * 100).toFixed(2)}%
                </div>
                <div className="stat-sub">缺失 {validation.lineage.missing_edges.length} · 虚构 {validation.lineage.spurious_edges.length}</div>
              </div>
              <div>
                <div className="stat-label">数量守恒</div>
                <div className="stat-value" style={{ fontSize: 20, color: validation.quantity.every((q) => q.ok) ? 'var(--ok)' : 'var(--danger)' }}>
                  {validation.quantity.every((q) => q.ok) ? '平衡' : '偏差'}
                </div>
                <div className="stat-sub">逐工序投入 = 产出 + 报废</div>
              </div>
              <div>
                <div className="stat-label">批次级产出比对</div>
                <div className="stat-value" style={{ fontSize: 20 }}>
                  {validation.batch_level.filter((b) => b.ok).length}<span className="faint" style={{ fontSize: 13 }}> / {validation.batch_level.length}</span>
                </div>
                <div className="stat-sub">产量完全一致</div>
              </div>
              <div>
                <div className="stat-label">端到端平均召回率</div>
                <div className="stat-value" style={{ fontSize: 20 }}>
                  {validation.end_to_end.length
                    ? `${((validation.end_to_end.reduce((s, e) => s + e.recall, 0) / validation.end_to_end.length) * 100).toFixed(1)}%`
                    : '—'}
                </div>
                <div className="stat-sub">原料 → 序列号</div>
              </div>
            </div>
            {showValidation && (
              <div className="grid cols-2" style={{ marginTop: 16 }}>
                <div>
                  <div className="small faint" style={{ marginBottom: 8 }}>数量守恒（追溯库实测）</div>
                  <table className="data">
                    <thead><tr><th>工序</th><th className="num">投入</th><th className="num">产出</th><th className="num">报废</th><th className="num">偏差</th></tr></thead>
                    <tbody>
                      {validation.quantity.map((q) => (
                        <tr key={q.stage}>
                          <td className="small">{q.stage}</td>
                          <td className="num">{q.input_qty.toLocaleString()}</td>
                          <td className="num">{q.output_qty.toLocaleString()}</td>
                          <td className="num">{q.scrap_qty.toLocaleString()}</td>
                          <td className="num" style={{ color: q.ok ? 'var(--ok)' : 'var(--danger)' }}>{q.variance.toFixed(2)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="small faint" style={{ margin: '14px 0 8px' }}>逐批归因对照（{validation.attribution.length} 个成品批）</div>
                  <table className="data">
                    <thead><tr><th>成品批次</th><th className="num">真值占比</th><th className="num">追溯占比</th><th className="num">偏差</th></tr></thead>
                    <tbody>
                      {validation.attribution.map((a) => (
                        <tr key={a.lot_no}>
                          <td className="mono small">{a.lot_no}</td>
                          <td className="num">{(a.truth_fraction * 100).toFixed(1)}%</td>
                          <td className="num">{(a.traced_fraction * 100).toFixed(1)}%</td>
                          <td className="num" style={{ color: a.ok ? 'var(--ok)' : 'var(--danger)' }}>{a.diff >= 0 ? '+' : ''}{(a.diff * 100).toFixed(2)}%</td>
                        </tr>
                      ))}
                      {!validation.attribution.length && <tr><td colSpan={4} className="faint">无投诉炉号</td></tr>}
                    </tbody>
                  </table>
                </div>
                <div>
                  <div className="small faint" style={{ marginBottom: 8 }}>原料 → 成品序列号 端到端</div>
                  <table className="data">
                    <thead><tr><th>原料批次</th><th className="num">真值序列号</th><th className="num">追溯</th><th className="num">精确率</th><th className="num">召回率</th></tr></thead>
                    <tbody>
                      {validation.end_to_end.map((e) => (
                        <tr key={e.raw_lot}>
                          <td className="mono small">{e.raw_lot}</td>
                          <td className="num">{e.truth_serials}</td>
                          <td className="num">{e.traced_serials}</td>
                          <td className="num" style={{ color: e.precision >= 0.99 ? 'var(--ok)' : 'var(--danger)' }}>{(e.precision * 100).toFixed(1)}%</td>
                          <td className="num" style={{ color: e.recall >= 0.99 ? 'var(--ok)' : 'var(--danger)' }}>{(e.recall * 100).toFixed(1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="small faint" style={{ margin: '14px 0 8px' }}>数据质量对照</div>
                  <div className="kv" style={{ gridTemplateColumns: '120px 1fr' }}>
                    <dt>生成时注入问题</dt><dd className="mono">{validation.data_quality.injected_issues} 处</dd>
                    <dt>系统识别</dt><dd className="mono">{validation.data_quality.detected_issues} 条</dd>
                    <dt>自动纠正/改判</dt><dd className="mono">{validation.data_quality.corrections_applied} 条</dd>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      <Card
        title="数据接入任务"
        hint={status.run ? `上次运行 ${status.run.run_at.replace('T', ' ').slice(0, 19)} · ${lastRun ? `${lastRun.elapsed}ms` : '—'}` : '尚未接入'}
        actions={<button className="btn btn-primary" onClick={run} disabled={running}>{running ? '正在接入…' : '重新接入并归一化'}</button>}
      >
        {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}
        <div className="grid cols-2">
          <div>
            <div className="small faint" style={{ marginBottom: 8 }}>源文件</div>
            <table className="data">
              <thead><tr><th>文件</th><th className="num">大小</th><th>导出时间</th></tr></thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.name}>
                    <td className="mono">{f.name}</td>
                    <td className="num">{(f.size / 1024).toFixed(1)} KB</td>
                    <td className="faint small">{f.modified.replace('T', ' ').slice(0, 19)}</td>
                  </tr>
                ))}
                {!files.length && <tr><td colSpan={3} className="faint">无文件</td></tr>}
              </tbody>
            </table>
          </div>
          <div>
            <div className="small faint" style={{ marginBottom: 8 }}>时间基准对齐</div>
            <table className="data">
              <thead><tr><th>系统</th><th className="num">记录数</th><th>时区假设</th><th>格式修正</th></tr></thead>
              <tbody>
                {timeStats.map((t) => (
                  <tr key={t.system}>
                    <td><span className="tag tag-gray">{t.system}</span></td>
                    <td className="num">{qty(t.records)}</td>
                    <td className="small muted">{t.assumed_tz}</td>
                    <td className="small faint">{t.fixed_formats.length ? t.fixed_formats.join('；') : '—'}</td>
                  </tr>
                ))}
                {!timeStats.length && <tr><td colSpan={4} className="faint">无</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </Card>

      <Card title="编码映射表" hint="MES 工艺编码 / WMS 10 位物料号 / QMS 短码 → 统一物料编码">
        <div className="grid cols-3">
          {['MES', 'WMS', 'QMS'].map((sys) => {
            const rows = mappingBySystem.get(sys) ?? [];
            const agg = new Map<string, { normalized: string; confidence: string }>();
            for (const r of rows) agg.set(r.raw, { normalized: r.normalized, confidence: r.confidence });
            return (
              <div key={sys}>
                <div className="small faint" style={{ marginBottom: 8 }}>{sys}</div>
                <table className="data">
                  <thead><tr><th>源编码</th><th>统一编码</th><th>置信度</th></tr></thead>
                  <tbody>
                    {[...agg.entries()].slice(0, 12).map(([raw, v]) => (
                      <tr key={raw}>
                        <td className="mono">{raw}</td>
                        <td className="mono" style={{ color: '#9dc4ff' }}>{v.normalized}</td>
                        <td>
                          <span className={`tag ${v.confidence === 'EXACT' ? 'tag-green' : v.confidence === 'RULE' ? 'tag-blue' : 'tag-amber'}`}>
                            {v.confidence === 'EXACT' ? '精确' : v.confidence === 'RULE' ? '规则' : '模糊'}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {!agg.size && <tr><td colSpan={3} className="faint">无映射</td></tr>}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      </Card>

      <Card
        title="数据质量问题清单"
        hint={`共 ${status.issues.length} 条 · 自动纠正/改判均已生效`}
        actions={
          <div style={{ display: 'flex', gap: 6 }}>
            {['ALL', 'ERROR', 'WARN', 'INFO'].map((s) => (
              <button key={s} className={`btn btn-sm ${filter === s ? 'btn-primary' : ''}`} onClick={() => setFilter(s)}>
                {s === 'ALL' ? '全部' : s} {s !== 'ALL' && <span className="pill-count">{sevCount(s)}</span>}
              </button>
            ))}
          </div>
        }
      >
        <div className="scroll" style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table className="data">
            <thead><tr><th style={{ width: 70 }}>级别</th><th style={{ width: 100 }}>环节</th><th style={{ width: 60 }}>系统</th><th>说明</th><th style={{ width: 170 }}>引用</th></tr></thead>
            <tbody>
              {[...issues].sort((a, b) => SEV_ORDER[a.severity as keyof typeof SEV_ORDER] - SEV_ORDER[b.severity as keyof typeof SEV_ORDER]).map((i, idx) => (
                <tr key={idx}>
                  <td><SeverityTag severity={i.severity} /></td>
                  <td className="small muted">{i.stage}</td>
                  <td className="small faint">{i.system}</td>
                  <td>{i.message}</td>
                  <td className="mono faint small">{i.ref}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
