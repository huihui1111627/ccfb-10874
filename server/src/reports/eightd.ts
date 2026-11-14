import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType,
  AlignmentType, BorderStyle, ShadingType
} from 'docx';
import { getDb } from '../db/index.js';
import { forwardTrace, backwardTraceBySerial, backwardTraceByLot, simulateRecall } from '../trace/service.js';
import { STAGE_NAME } from '../../../shared/materials.js';
import type { EightDReport, StageCode } from '../../../shared/types.js';

export interface EightDInput {
  lot?: string;
  serial?: string;
  complaintNo?: string;
  customerCode?: string;
}

function round(n: number, d = 1): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export async function buildEightD(input: EightDInput): Promise<{ report: EightDReport; docxBuffer: Buffer; markdown: string }> {
  const db = getDb();
  const complaint = db.prepare(`SELECT value FROM meta WHERE key='complaint'`).get() as { value: string } | undefined;
  const complaintData = complaint ? JSON.parse(complaint.value) as {
    complaint_no: string; customer_code: string; customer_name: string; product: string;
    issue: string; reported_at: string; heat_lot: string; serials: string[];
  } : null;

  const serial = input.serial ?? complaintData?.serials[0];
  let startLot = input.lot ?? complaintData?.heat_lot ?? '';
  let customer = input.customerCode ?? complaintData?.customer_code ?? '';
  if (serial && !input.lot) {
    const row = db.prepare(`SELECT lot_no FROM serials WHERE serial_no = ?`).get(serial) as { lot_no: string } | undefined;
    if (row) startLot = startLot || row.lot_no;
  }
  if (!startLot) throw new Error('无法确定追溯起点：请提供批次号或序列号');

  const startLotRow = db.prepare(`SELECT * FROM lots WHERE lot_no = ?`).get(startLot) as {
    lot_no: string; material_name: string; stage: string; supplier: string | null; qty_produced: number;
    is_raw: number; suspect: number; production_date: string;
  } | undefined;
  if (!startLotRow) throw new Error(`批次不存在: ${startLot}`);

  // 追溯主体：若从原料起，走正向；若从成品起，反向 + 取其原料再正向
  const forward = forwardTrace(startLotRow.is_raw ? startLot : findRootRawLot(startLot) ?? startLot);
  const rawLot = startLotRow.is_raw ? startLot : findRootRawLot(startLot) ?? startLot;
  const recall = simulateRecall({ lot: rawLot });
  const backward = serial ? backwardTraceBySerial(serial) : backwardTraceByLot(forward.finished_lots[0]?.lot_no ?? startLot);

  const rawLots = db.prepare(`
    SELECT l.lot_no, l.supplier, l.qty_produced, l.material_name FROM lots l
    WHERE l.is_raw = 1 AND l.lot_no IN (${backward.raw_lots.map(() => '?').join(',') || "''"})
  `).all(...backward.raw_lots) as { lot_no: string; supplier: string | null; qty_produced: number; material_name: string }[];

  const failures = db.prepare(`
    SELECT q.inspection_no, q.lot_no, q.item, q.measured_value, q.upper_limit, q.lower_limit, q.inspected_at, q.inspection_type
    FROM inspections q WHERE q.result='FAIL' AND q.lot_no IN (${backward.raw_lots.map(() => '?').join(',') || "''"})
    ORDER BY q.inspected_at
  `).all(...backward.raw_lots) as { inspection_no: string; lot_no: string; item: string; measured_value: number; upper_limit: number; lower_limit: number; inspected_at: string; inspection_type: string }[];

  const affectedSerials = new Set(recall.shipments.flatMap((s) => s.serials));
  const customers = [...new Map(recall.shipments.map((s) => [s.customer_code, s.customer_name])).entries()];
  const paramKeys = new Set<string>();
  for (const hop of backward.hops) for (const k of Object.keys(hop.params)) paramKeys.add(k);
  const keyParams = [...paramKeys].slice(0, 8);

  const quantityBalance: EightDReport['quantity_balance'] = [];
  for (const stage of ['CAST', 'MACH', 'ASSY', 'FINAL'] as const) {
    const row = db.prepare(`
      SELECT COALESCE(SUM((SELECT SUM(qty) FROM op_inputs WHERE op_id = o.op_id AND o.stage != 'ASSY' OR (o.stage='ASSY' AND role='MAIN'))),0) AS inq,
             COALESCE(SUM((SELECT SUM(qty) FROM op_outputs WHERE op_id = o.op_id)),0) AS outq,
             COALESCE(SUM(o.scrap_qty),0) AS scrap
      FROM operations o WHERE o.stage = ?
    `).get(stage) as { inq: number; outq: number; scrap: number };
    const outNormalized = stage === 'CAST' ? row.outq * 2.45 : row.outq;
    quantityBalance.push({
      stage: `${stage} ${STAGE_NAME[stage as StageCode]}`,
      input: round(row.inq), output: round(outNormalized), scrap: round(row.scrap, 1), rework: 0,
      balanced: Math.abs(row.inq - outNormalized - row.scrap) / Math.max(row.inq, 1) < 0.03
    });
  }

  const firstFail = failures[0];
  const chemistryParams = backward.hops
    .flatMap((h) => Object.entries(h.params).map(([k, v]) => ({ stage: h.stage_name, k, v })))
    .filter((p) => /温度|含铁|浇注|转速|扭矩|压力|同轴/.test(p.k))
    .slice(0, 12);

  const report: EightDReport = {
    title: `8D 质量投诉报告 — ${complaintData?.complaint_no ?? input.complaintNo ?? 'CC-2025-0917'}`,
    generated_at: new Date().toISOString(),
    header: {
      complaint_no: input.complaintNo ?? complaintData?.complaint_no ?? 'CC-2025-0917',
      product: 'CAL-FIN 刹车卡钳成品（配套乘用车前制动）',
      customer: customer || complaintData?.customer_name || recall.shipments[0]?.customer_name || '客户',
      issue: complaintData?.issue ?? '制动异响 / 活塞孔同轴度超差'
    },
    d1_team: ['质量总监（组长）', '铸造工艺工程师', '机加工艺工程师', 'SQE（供应商质量）', 'MES/追溯系统工程师', '客户质量代表'],
    d2_problem: `客户 ${customer || complaintData?.customer_name} 于 ${complaintData?.reported_at ?? '2025-09-29'} 反馈卡钳总成装车后制动异响。` +
      `经拆检确认活塞孔同轴度超差。追溯锁定起始原料批次 ${rawLot}` +
      `${firstFail ? `，该批次 IQC 检验 ${firstFail.inspection_no} 的${firstFail.item}实测 ${firstFail.measured_value}，超出规格上限 ${firstFail.upper_limit}` : ''}。` +
      `谱系展开涉及 ${forward.finished_lots.length} 个成品批次、${affectedSerials.size} 件已发序列号，覆盖 ${customers.length} 家客户；` +
      `按安全件整批口径需召回 ${recall.total_conservative_qty.toFixed(0)} 件（精确折算 ${recall.total_affected_qty.toFixed(0)} 件）。`,
    d3_containment: [
      `已冻结库存：${recall.blocked_inventory.reduce((s, b) => s + b.qty, 0).toFixed(0)} 件未发货成品（${recall.blocked_inventory.length} 个批次）就地隔离`,
      `已发起客户拦截：${recall.shipments.length} 张发货单、${recall.total_conservative_qty.toFixed(0)} 件（整批口径），其中 A 级（30 天内发货）${recall.shipments.filter((s) => s.priority === 'A').length} 张`,
      `已暂停炉号 ${rawLot} 的后续投料，同供应商其余炉号加做含铁量复检`,
      `已对 ${forward.finished_lots.length} 个成品批次追加泄漏率与同轴度全检`
    ],
    d4_root_cause: firstFail
      ? `直接原因：原料 ${rawLots[0]?.lot_no ?? rawLot}（供应商 ${rawLots[0]?.supplier ?? '待确认'}）${firstFail.item}实测 ${firstFail.measured_value}，超出上限 ${firstFail.upper_limit}，` +
        `导致毛坯切削性能下降，机加工后活塞孔同轴度漂移超差。` +
        `流出原因：IQC 判定为 FAIL 后未联动 MES 冻结对应炉号，且 WMS 收货批次与 MES 投料批次未建立强关联，导致异常炉料仍被投入熔炼。` +
        `根本原因：缺少原料-在制-成品的强谱系，不合格批次无法在 2 小时内定位下游流向。`
      : `根本原因待确认：起始批次 ${rawLot} 未检出不合格记录，需补充来料复检并复核工艺参数。`,
    d5_corrective: [
      `对受影响成品批次执行 100% 同轴度 + 泄漏率复检，不合格直接报废`,
      `将 IQC 判定与 MES 工单冻结打通：IQC FAIL 时自动锁库并拦截投料`,
      `要求供应商 ${rawLots[0]?.supplier ?? '（待确认）'} 提供同批次炉前光谱分析报告并加严含铁量到 ≤0.85%`,
      `在 MES 增加投料批次扫码校验，杜绝手工录入批次号`
    ],
    d6_implemented: [
      `已上线批次追溯系统：正向追溯响应时间从 3 天缩短至 ${forward.elapsed_ms} ms`,
      `已按谱系完成 ${recall.shipments.length} 张发货单的客户通知，随附本 8D 报告`,
      `已对 ${recall.total_conservative_qty.toFixed(0)} 件发出品启动召回/换件流程，预估费用 ¥${recall.cost_estimate.total.toLocaleString('zh-CN')}`
    ],
    d7_prevent: [
      `批次谱系纳入质量体系文件，任何拆批/合批/返工必须在 MES 记录父子批次`,
      `IQC 不合格自动传播标记下游批次（当前已覆盖 ${forward.suspect_lots.length} 个可疑批次）`,
      `每月执行一次追溯演练与数量守恒校验，偏差 > 2% 触发纠正`,
      `三系统（MES/WMS/QMS）编码与时间统一走主数据映射表`
    ],
    d8_closure: `本期 8D 于 ${new Date().toISOString().slice(0, 10)} 提交客户确认。召回数量、发货单与序列号明细见附件，` +
      `批次谱系与数量守恒报告随附。待客户确认换件完成率后关闭。`,
    attachments: [
      { name: '附件A_原料批次清单.csv', description: '涉及的全部原料批次、供应商与投料数量' },
      { name: '附件B_成品批次与序列号.csv', description: '受影响成品批次、序列号与发货单对应关系' },
      { name: '附件C_工序参数记录.csv', description: '每个工序的设备、操作工与关键工艺参数' },
      { name: '附件D_数量守恒校验.csv', description: '各工序投入/产出/报废/返工数量与偏差' },
      { name: '附件E_可疑批次清单.csv', description: '质检不合格及其下游传播标记的批次' }
    ],
    trace_summary: {
      raw_lots: rawLots.map((r) => ({ lot_no: r.lot_no, supplier: r.supplier ?? '—', qty: r.qty_produced })),
      affected_lots: forward.nodes.length,
      affected_serials: affectedSerials.size,
      shipped_qty: recall.total_conservative_qty,
      customers: customers.map(([code, name]) => `${name}(${code})`),
      shipments: recall.shipments.map((s) => s.shipment_no)
    },
    quantity_balance: quantityBalance
  };

  const markdown = renderMarkdown(report, keyParams, chemistryParams, recall);
  const docxBuffer = await renderDocx(report, keyParams, chemistryParams, recall);
  return { report, docxBuffer, markdown };
}

function findRootRawLot(lot: string): string | null {
  const db = getDb();
  const children = db.prepare(`SELECT parent_lot FROM edges WHERE child_lot = ?`).all(lot) as { parent_lot: string }[];
  if (!children.length) {
    const l = db.prepare(`SELECT is_raw FROM lots WHERE lot_no = ?`).get(lot) as { is_raw: number } | undefined;
    return l?.is_raw ? lot : null;
  }
  for (const c of children) {
    const root = findRootRawLot(c.parent_lot);
    if (root) return root;
  }
  return null;
}

function renderMarkdown(
  r: EightDReport, keyParams: string[],
  chemistry: { stage: string; k: string; v: string | number }[],
  recall: ReturnType<typeof simulateRecall>
): string {
  const lines: string[] = [];
  lines.push(`# ${r.title}`, '');
  lines.push(`> 生成时间：${r.generated_at}　客户：${r.header.customer}　产品：${r.header.product}`, '');
  lines.push('## D1 团队', '', r.d1_team.map((t) => `- ${t}`).join('\n'), '');
  lines.push('## D2 问题描述', '', r.d2_problem, '');
  lines.push('## D3 围堵措施', '', r.d3_containment.map((t) => `- ${t}`).join('\n'), '');
  lines.push('## D4 根本原因', '', r.d4_root_cause, '');
  lines.push('## D5 纠正措施', '', r.d5_corrective.map((t) => `- ${t}`).join('\n'), '');
  lines.push('## D6 实施与验证', '', r.d6_implemented.map((t) => `- ${t}`).join('\n'), '');
  lines.push('## D7 预防再发生', '', r.d7_prevent.map((t) => `- ${t}`).join('\n'), '');
  lines.push('## D8 结案', '', r.d8_closure, '');
  lines.push('## 附录：追溯摘要', '');
  lines.push('| 原料批次 | 供应商 | 数量 |', '| --- | --- | --- |');
  for (const rl of r.trace_summary.raw_lots) lines.push(`| ${rl.lot_no} | ${rl.supplier} | ${rl.qty} |`);
  lines.push('', `受影响批次 ${r.trace_summary.affected_lots} 个，序列号 ${r.trace_summary.affected_serials} 件，发货单 ${r.trace_summary.shipments.join('、')}`, '');
  lines.push('### 关键工艺参数', '', '| 工序 | 参数 | 数值 |', '| --- | --- | --- |');
  for (const p of chemistry) lines.push(`| ${p.stage} | ${p.k} | ${p.v} |`);
  lines.push('', '### 数量守恒', '', '| 工序 | 投入 | 产出(折算) | 报废 | 偏差 | 结论 |', '| --- | --- | --- | --- | --- | --- |');
  for (const q of r.quantity_balance) lines.push(`| ${q.stage} | ${q.input} | ${q.output} | ${q.scrap} | ${(q.input - q.output - q.scrap).toFixed(1)} | ${q.balanced ? '平衡' : '偏差'} |`);
  lines.push('', `召回成本预估：¥${recall.cost_estimate.total.toLocaleString('zh-CN')}（物流 ¥${recall.cost_estimate.freight.toLocaleString('zh-CN')} + 返修 ¥${recall.cost_estimate.rework.toLocaleString('zh-CN')} + 报废 ¥${recall.cost_estimate.scrap.toLocaleString('zh-CN')}）`);
  return lines.join('\n');
}

async function renderDocx(
  r: EightDReport, keyParams: string[],
  chemistry: { stage: string; k: string; v: string | number }[],
  recall: ReturnType<typeof simulateRecall>
): Promise<Buffer> {
  const heading = (text: string) => new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 } });
  const body = (text: string) => new Paragraph({ children: [new TextRun({ text, size: 21 })], spacing: { after: 80 } });
  const bullet = (text: string) => new Paragraph({ text, bullet: { level: 0 }, spacing: { after: 40 } });

  const cell = (text: string, bold = false, fill?: string) => new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text, bold, size: 18 })] })],
    shading: fill ? { type: ShadingType.CLEAR, fill, color: 'auto' } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 }
  });

  const rawTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: [cell('原料批次', true, 'E8EEF7'), cell('供应商', true, 'E8EEF7'), cell('数量', true, 'E8EEF7')] }),
      ...r.trace_summary.raw_lots.map((rl) => new TableRow({ children: [cell(rl.lot_no), cell(rl.supplier), cell(String(rl.qty))] }))
    ]
  });
  const paramTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: [cell('工序', true, 'E8EEF7'), cell('参数', true, 'E8EEF7'), cell('数值', true, 'E8EEF7')] }),
      ...chemistry.map((p) => new TableRow({ children: [cell(p.stage), cell(p.k), cell(String(p.v))] }))
    ]
  });
  const balanceTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: [cell('工序', true, 'E8EEF7'), cell('投入', true, 'E8EEF7'), cell('产出(折算)', true, 'E8EEF7'), cell('报废', true, 'E8EEF7'), cell('偏差', true, 'E8EEF7'), cell('结论', true, 'E8EEF7')] }),
      ...r.quantity_balance.map((q) => new TableRow({
        children: [
          cell(q.stage), cell(q.input.toFixed(1)), cell(q.output.toFixed(1)), cell(q.scrap.toFixed(1)),
          cell((q.input - q.output - q.scrap).toFixed(1)), cell(q.balanced ? '平衡' : '偏差', false, q.balanced ? 'E6F4EA' : 'FCE8E6')
        ]
      }))
    ]
  });

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: 'PingFang SC', size: 21 } }
      }
    },
    sections: [{
      children: [
        new Paragraph({ text: r.title, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: `投诉编号 ${r.header.complaint_no}　|　客户 ${r.header.customer}　|　生成于 ${r.generated_at.slice(0, 19).replace('T', ' ')}`, size: 18, color: '555555' })]
        }),
        heading('D1 团队成员'), ...r.d1_team.map(bullet),
        heading('D2 问题描述'), body(r.d2_problem),
        heading('D3 围堵措施'), ...r.d3_containment.map(bullet),
        heading('D4 根本原因分析'), body(r.d4_root_cause),
        heading('D5 纠正措施'), ...r.d5_corrective.map(bullet),
        heading('D6 实施与效果验证'), ...r.d6_implemented.map(bullet),
        heading('D7 预防再发生'), ...r.d7_prevent.map(bullet),
        heading('D8 结案与客户确认'), body(r.d8_closure),
        heading('附件 A：原料批次清单'), rawTable,
        heading('附件 B：关键工艺参数'), paramTable,
        heading('附件 C：数量守恒校验'),
        balanceTable,
        body(`召回成本预估：¥${recall.cost_estimate.total.toLocaleString('zh-CN')}（物流 ¥${recall.cost_estimate.freight.toLocaleString('zh-CN')} + 返修 ¥${recall.cost_estimate.rework.toLocaleString('zh-CN')} + 报废 ¥${recall.cost_estimate.scrap.toLocaleString('zh-CN')}）`),
        body(`受影响发货单：${r.trace_summary.shipments.join('、')}`),
        body(`涉及客户：${r.trace_summary.customers.join('、')}`)
      ]
    }]
  });
  void keyParams;
  return Packer.toBuffer(doc);
}
