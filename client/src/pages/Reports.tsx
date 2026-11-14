import { useEffect, useMemo, useState } from 'react';
import { api, type Complaint } from '../api';
import type { EightDReport } from '../../../shared/types';
import { Card, Empty, ErrorBox, Loading, money, qty } from '../components/ui';

export default function Reports() {
  const [complaint, setComplaint] = useState<Complaint | null>(null);
  const [report, setReport] = useState<EightDReport | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [download, setDownload] = useState('');
  const [bytes, setBytes] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [lot, setLot] = useState('');
  const [customer, setCustomer] = useState('');

  useEffect(() => {
    api.complaint().then((c) => {
      setComplaint(c);
      if (c) {
        setLot(c.heat_lot);
        setCustomer(c.customer_code);
        generate(c.heat_lot, c.customer_code, c.serials[0]);
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const generate = async (l?: string, cust?: string, serial?: string) => {
    setLoading(true);
    setError('');
    try {
      const r = await api.eightd({ lot: l ?? lot, serial, customer: cust ?? customer, complaint_no: complaint?.complaint_no });
      setReport(r.report);
      setMarkdown(r.markdown);
      setDownload(r.download);
      setBytes(r.bytes);
    } catch (e) {
      setError((e as Error).message);
      setReport(null);
    } finally {
      setLoading(false);
    }
  };

  const sections = useMemo(() => {
    if (!report) return [];
    return [
      { key: 'D1', title: '团队组建', body: report.d1_team },
      { key: 'D2', title: '问题描述', body: report.d2_problem },
      { key: 'D3', title: '围堵措施', body: report.d3_containment },
      { key: 'D4', title: '根本原因', body: report.d4_root_cause },
      { key: 'D5', title: '纠正措施', body: report.d5_corrective },
      { key: 'D6', title: '实施与验证', body: report.d6_implemented },
      { key: 'D7', title: '预防再发生', body: report.d7_prevent },
      { key: 'D8', title: '结案', body: report.d8_closure }
    ];
  }, [report]);

  return (
    <>
      <div className="section-head">
        <h2>8D 报告生成</h2>
        <p>把追溯结论、原料/工艺明细、召回范围与数量守恒结果组装成可交付客户的 8D 附件</p>
      </div>

      <Card>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <input className="input input-lg mono" style={{ width: 260 }} placeholder="起始批次 / 炉号" value={lot} onChange={(e) => setLot(e.target.value)} />
          <select className="select" value={customer} onChange={(e) => setCustomer(e.target.value)}>
            <option value="CH-A">上海汽车制动系统有限公司</option>
            <option value="CH-B">广州底盘科技有限公司</option>
            <option value="CH-C">成都车桥股份有限公司</option>
            <option value="CH-D">华北汽配售后市场</option>
            <option value="CH-E">NorthStar Auto Parts</option>
          </select>
          <button className="btn btn-primary" onClick={() => generate()} disabled={loading}>{loading ? '生成中…' : '生成 8D 报告'}</button>
          {download && (
            <a className="btn" href={download} style={{ borderColor: 'rgba(53,201,138,.4)', color: '#6fe0ae' }}>
              下载 Word (.docx) · {(bytes / 1024).toFixed(0)} KB
            </a>
          )}
          <div className="spacer" />
          {report && <span className="faint small">生成于 {report.generated_at.replace('T', ' ').slice(0, 19)}</span>}
        </div>
      </Card>

      {error && <div style={{ marginTop: 16 }}><ErrorBox error={error} /></div>}
      {loading && <Loading text="正在生成 8D 报告…" />}
      {!report && !loading && !error && <div style={{ marginTop: 16 }}><Card><Empty>选择批次和客户后生成报告</Empty></Card></div>}

      {report && (
        <>
          <div className="grid cols-4" style={{ marginTop: 16 }}>
            <Card><div className="stat-label">投诉编号</div><div className="mono" style={{ fontSize: 15, marginTop: 6 }}>{report.header.complaint_no}</div><div className="stat-sub">{report.header.customer}</div></Card>
            <Card><div className="stat-label">受影响批次</div><div className="stat-value">{report.trace_summary.affected_lots}</div><div className="stat-sub">原料 {report.trace_summary.raw_lots.length} 个</div></Card>
            <Card><div className="stat-label">受影响序列号</div><div className="stat-value" style={{ color: 'var(--warn)' }}>{qty(report.trace_summary.affected_serials)}</div><div className="stat-sub">{report.trace_summary.shipments.length} 张发货单</div></Card>
            <Card><div className="stat-label">召回成本</div><div className="stat-value" style={{ color: 'var(--danger)', fontSize: 20 }}>{money(markdownTotal(markdown))}</div><div className="stat-sub">含物流/返修/报废</div></Card>
          </div>

          <div className="split-wide" style={{ marginTop: 16 }}>
            <Card title="8D 报告正文" hint="与导出的 Word 内容一致">
              <div className="scroll-y" style={{ maxHeight: 620, paddingRight: 8 }}>
                {sections.map((s) => (
                  <div key={s.key} style={{ marginBottom: 18 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
                      <span style={{
                        width: 26, height: 20, borderRadius: 4, background: 'var(--accent-soft)', color: '#9dc4ff',
                        display: 'grid', placeItems: 'center', fontSize: 10.5, fontWeight: 650, fontFamily: 'var(--mono)'
                      }}>{s.key}</span>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{s.title}</span>
                    </div>
                    <div style={{ paddingLeft: 34 }}>
                      {Array.isArray(s.body) ? (
                        s.body.map((b, i) => (
                          <div key={i} style={{ display: 'flex', gap: 7, fontSize: 12.5, lineHeight: 1.75, color: 'var(--text-dim)' }}>
                            <span className="faint">·</span><span>{b}</span>
                          </div>
                        ))
                      ) : (
                        <div style={{ fontSize: 12.5, lineHeight: 1.75, color: 'var(--text-dim)' }}>{s.body}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <div>
              <Card title="附件清单">
                {report.attachments.map((a) => (
                  <div key={a.name} style={{ display: 'flex', gap: 8, padding: '7px 0', borderBottom: '1px solid rgba(42,53,70,.5)' }}>
                    <span style={{ color: '#9dc4ff', fontSize: 12 }}>▤</span>
                    <div>
                      <div style={{ fontSize: 12 }}>{a.name}</div>
                      <div className="faint" style={{ fontSize: 10.5 }}>{a.description}</div>
                    </div>
                  </div>
                ))}
              </Card>

              <Card title="追溯摘要">
                <dl className="kv" style={{ gridTemplateColumns: '84px 1fr' }}>
                  <dt>涉及客户</dt><dd className="small">{report.trace_summary.customers.join('、') || '—'}</dd>
                  <dt>发货单</dt><dd className="mono small">{report.trace_summary.shipments.join(', ') || '—'}</dd>
                  <dt>已发货</dt><dd className="mono">{qty(report.trace_summary.shipped_qty, 1)} 件</dd>
                </dl>
                <div className="small faint" style={{ margin: '12px 0 6px' }}>原料批次</div>
                <table className="data">
                  <thead><tr><th>批次</th><th>供应商</th><th className="num">数量</th></tr></thead>
                  <tbody>
                    {report.trace_summary.raw_lots.map((r) => (
                      <tr key={r.lot_no}>
                        <td className="mono small">{r.lot_no}</td>
                        <td className="small faint">{r.supplier}</td>
                        <td className="num">{qty(r.qty, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>

              <Card title="数量守恒校验">
                <table className="data">
                  <thead><tr><th>工序</th><th className="num">投入</th><th className="num">产出</th><th className="num">报废</th><th>结论</th></tr></thead>
                  <tbody>
                    {report.quantity_balance.map((q) => (
                      <tr key={q.stage}>
                        <td className="small">{q.stage}</td>
                        <td className="num">{qty(q.input, 1)}</td>
                        <td className="num">{qty(q.output, 1)}</td>
                        <td className="num">{qty(q.scrap, 1)}</td>
                        <td><span className={`tag ${q.balanced ? 'tag-green' : 'tag-red'}`}>{q.balanced ? '平衡' : '偏差'}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function markdownTotal(md: string): number {
  const m = md.match(/召回成本预估：¥([\d,]+)/);
  return m ? Number(m[1].replace(/,/g, '')) : 0;
}
