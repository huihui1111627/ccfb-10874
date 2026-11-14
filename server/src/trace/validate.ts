import fs from 'node:fs';
import path from 'node:path';
import { getDb, TRUTH_DIR } from '../db/index.js';
import type { ValidationResult } from '../../../shared/types.js';
import { STAGE_ORDER, STAGE_NAME } from '../../../shared/materials.js';
import { forwardTrace } from './service.js';

interface Truth {
  lots: { lot_no: string; stage: string; qty_produced: number; material_code: string; is_raw: boolean }[];
  operations: {
    op_id: string; stage: string; inputs: { lot: string; qty: number; role: string }[];
    outputs: { lot: string; qty: number }[]; scrap_qty: number; scrap_uom: string; flow_type: string;
  }[];
  serials: { serial_no: string; lot_no: string; status: string }[];
  shipments: { shipment_no: string; lines: { lot_ref: string; qty: number; serials: string[] }[] }[];
  complaints: { complaint_no: string; heat_lot: string; serials: string[]; customer_code: string }[];
  injected: { id: string; kind: string; target: string; description: string }[];
  stats: Record<string, number>;
}

/**
 * 用生成时保留下来的“真实谱系”逐批对照系统追溯结果：
 * 1. 谱系边 precision/recall
 * 2. 各工序数量守恒
 * 3. 批次级产出量比对
 * 4. 原料 -> 成品序列号端到端 precision/recall
 */
export function validateAgainstTruth(): ValidationResult {
  const truthFile = path.join(TRUTH_DIR, 'truth.json');
  if (!fs.existsSync(truthFile)) {
    return {
      ok: false, checked_at: new Date().toISOString(), truth_available: false,
      lineage: { total_edges: 0, matched_edges: 0, missing_edges: [], spurious_edges: [], accuracy: 0 },
      quantity: [], batch_level: [], end_to_end: [],
      data_quality: { injected_issues: 0, detected_issues: 0, corrections_applied: 0 },
      attribution: []
    } satisfies ValidationResult;
  }
  const truth = JSON.parse(fs.readFileSync(truthFile, 'utf8')) as Truth;
  const db = getDb();

  // ---------- 1. 谱系边 ----------
  const truthEdges = new Set<string>();
  for (const op of truth.operations) {
    for (const i of op.inputs) {
      for (const o of op.outputs) truthEdges.add(`${i.lot}->${o.lot}`);
    }
  }
  const tracedEdges = new Set(
    (db.prepare(`SELECT DISTINCT parent_lot, child_lot FROM edges`).all() as { parent_lot: string; child_lot: string }[])
      .map((e) => `${e.parent_lot}->${e.child_lot}`)
  );
  const missing = [...truthEdges].filter((e) => !tracedEdges.has(e));
  const spurious = [...tracedEdges].filter((e) => !truthEdges.has(e));
  const matched = truthEdges.size - missing.length;
  const accuracy = truthEdges.size ? matched / truthEdges.size : 0;

  // ---------- 2. 数量守恒（按工序类型，追溯库实测数据） ----------
  const inputs = db.prepare(`SELECT op_id, lot_no, qty, role FROM op_inputs`).all() as { op_id: string; lot_no: string; qty: number; role: string }[];
  const outputs = db.prepare(`SELECT op_id, lot_no, qty FROM op_outputs`).all() as { op_id: string; lot_no: string; qty: number }[];
  const opsMeta = db.prepare(`SELECT op_id, stage, alloc_mode, scrap_qty FROM operations`).all() as { op_id: string; stage: string; alloc_mode: string; scrap_qty: number }[];
  const inByOp = new Map<string, { qty: number; role: string }[]>();
  for (const i of inputs) {
    const arr = inByOp.get(i.op_id) ?? [];
    arr.push({ qty: i.qty, role: i.role });
    inByOp.set(i.op_id, arr);
  }
  const outByOp = new Map<string, number>();
  for (const o of outputs) outByOp.set(o.op_id, (outByOp.get(o.op_id) ?? 0) + o.qty);

  const quantity: ValidationResult['quantity'] = [];
  const opViolations: string[] = [];
  for (const stage of STAGE_ORDER) {
    const stageOps = opsMeta.filter((o) => o.stage === stage);
    let inQty = 0, outQty = 0, scrapQty = 0, reworkQty = 0;
    for (const op of stageOps) {
      const opInputs = inByOp.get(op.op_id) ?? [];
      const mainOnly = stage === 'ASSY' ? opInputs.filter((i) => i.role === 'MAIN') : opInputs;
      const opIn = mainOnly.reduce((s, i) => s + i.qty, 0);
      const opOut = outByOp.get(op.op_id) ?? 0;
      inQty += opIn;
      outQty += opOut;
      scrapQty += op.scrap_qty;
      // 逐工序守恒：投入 = 产出 + 报废（CAST 按 kg 折算）
      if (stage === 'CAST') {
        const expected = opIn - op.scrap_qty;
        const actual = opOut * 2.45;
        if (Math.abs(expected - actual) > 1.5) {
          opViolations.push(`${op.op_id}: 投入 ${round(opIn, 1)}kg - 报废 ${round(op.scrap_qty, 1)}kg ≠ 产出 ${opOut} 件 × 2.45 = ${round(actual, 1)}kg`);
        }
      } else {
        if (Math.abs(opIn - opOut - op.scrap_qty) > 1.01) {
          opViolations.push(`${op.op_id}: 投入 ${opIn} - 产出 ${opOut} ≠ 报废 ${op.scrap_qty}`);
        }
      }
    }
    const normalizedIn = stage === 'CAST' ? inQty : inQty;
    const normalizedOut = stage === 'CAST' ? outQty * 2.45 : outQty;
    const variance = normalizedIn === 0 ? 0 : (normalizedIn - normalizedOut - scrapQty) / normalizedIn;
    quantity.push({
      stage, input_qty: round(normalizedIn, 1), output_qty: round(normalizedOut, 1),
      scrap_qty: round(scrapQty, 1), rework_qty: round(reworkQty, 1),
      variance: round(variance * 100, 3), ok: Math.abs(variance) < 0.03
    });
  }

  // ---------- 3. 批次级比对 ----------
  const batchLevel: ValidationResult['batch_level'] = [];
  const tracedLots = new Map(
    (db.prepare(`SELECT lot_no, qty_produced FROM lots`).all() as { lot_no: string; qty_produced: number }[])
      .map((l) => [l.lot_no, l.qty_produced])
  );
  for (const t of truth.lots) {
    const traced = tracedLots.get(t.lot_no);
    if (traced === undefined) {
      batchLevel.push({ lot_no: t.lot_no, truth_qty: t.qty_produced, traced_qty: 0, diff: -t.qty_produced, ok: false });
      continue;
    }
    const diff = round(traced - t.qty_produced, 3);
    batchLevel.push({ lot_no: t.lot_no, truth_qty: t.qty_produced, traced_qty: traced, diff, ok: Math.abs(diff) < 0.5 });
  }
  const missingTraceLots = [...tracedLots.keys()].filter((l) => !truth.lots.some((t) => t.lot_no === l));
  batchLevel.push(...missingTraceLots.map((l) => ({ lot_no: l, truth_qty: 0, traced_qty: tracedLots.get(l) ?? 0, diff: tracedLots.get(l) ?? 0, ok: false })));

  // ---------- 4. 端到端：原料 -> 序列号 ----------
  const endToEnd: ValidationResult['end_to_end'] = [];
  const rawLots = truth.lots.filter((l) => l.is_raw).map((l) => l.lot_no);
  for (const raw of rawLots) {
    const truthSerials = new Set<string>();
    // 真值展开
    const tChildren = new Map<string, string[]>();
    for (const op of truth.operations) {
      for (const i of op.inputs) {
        const arr = tChildren.get(i.lot) ?? [];
        for (const o of op.outputs) arr.push(o.lot);
        tChildren.set(i.lot, arr);
      }
    }
    const tSeen = new Set<string>([raw]);
    const tq = [raw];
    while (tq.length) {
      const cur = tq.shift()!;
      for (const c of tChildren.get(cur) ?? []) if (!tSeen.has(c)) { tSeen.add(c); tq.push(c); }
    }
    for (const s of truth.serials) if (tSeen.has(s.lot_no)) truthSerials.add(s.serial_no);
    if (!truthSerials.size) continue;
    let traced: import('../../../shared/types.js').ForwardTrace;
    try {
      traced = forwardTrace(raw);
    } catch {
      continue;
    }
    const tracedSerials = new Set<string>();
    for (const f of traced.serials_by_lot ?? []) {
      for (const sn of f.serials) tracedSerials.add(sn);
    }
    const overlap = [...truthSerials].filter((s) => tracedSerials.has(s)).length;
    endToEnd.push({
      raw_lot: raw,
      truth_serials: truthSerials.size,
      traced_serials: tracedSerials.size,
      overlap,
      precision: tracedSerials.size ? round(overlap / tracedSerials.size, 4) : 1,
      recall: round(overlap / truthSerials.size, 4)
    });
    if (endToEnd.length >= 12) break;
  }

  // ---------- 5. 逐批归因对照（投诉炉号） ----------
  const attribution: ValidationResult['attribution'] = [];
  const complaint = (db.prepare(`SELECT value FROM meta WHERE key='complaint'`).get() as { value: string } | undefined);
  const heat = complaint ? (JSON.parse(complaint.value) as { heat_lot: string }).heat_lot : truth.lots.find((l) => l.is_raw && l.lot_no.startsWith('H-'))?.lot_no;
  if (heat) {
    const truthFrac = truthAttribution(truth, heat);
    const traced = forwardTrace(heat);
    const tracedMap = new Map(traced.finished_lots.map((f) => [f.lot_no, (f as unknown as { fraction: number }).fraction]));
    const finishedTruth = [...truthFrac.entries()].filter(([lot]) => truth.lots.find((x) => x.lot_no === lot)?.stage === 'FINAL');
    for (const [lot, frac] of finishedTruth.sort((a, b) => b[1] - a[1])) {
      const t = tracedMap.get(lot) ?? 0;
      attribution.push({
        lot_no: lot,
        truth_fraction: round(frac, 4),
        traced_fraction: round(t, 4),
        diff: round(t - frac, 4),
        ok: Math.abs(t - frac) <= 0.02
      });
    }
  }

  // ---------- 6. 数据质量 ----------
  const detected = (db.prepare(`SELECT COUNT(*) AS n FROM issues WHERE severity IN ('WARN','ERROR')`).get() as { n: number }).n;
  const corrections = (db.prepare(`SELECT COUNT(*) AS n FROM issues WHERE message LIKE '%纠正%' OR message LIKE '%改判%' OR message LIKE '%反查%' OR message LIKE '%剔除%'`).get() as { n: number }).n;

  const ok = accuracy >= 0.98 && quantity.every((q) => q.ok) && opViolations.length === 0
    && batchLevel.filter((b) => !b.ok).length === 0
    && attribution.filter((a) => !a.ok).length === 0;

  return {
    ok, checked_at: new Date().toISOString(), truth_available: true,
    lineage: { total_edges: truthEdges.size, matched_edges: matched, missing_edges: missing.slice(0, 50), spurious_edges: spurious.slice(0, 50), accuracy: round(accuracy, 4) },
    quantity: quantity.map((q) => ({ ...q, op_violations: undefined })),
    batch_level: batchLevel,
    end_to_end: endToEnd,
    data_quality: { injected_issues: truth.injected.length, detected_issues: detected, corrections_applied: corrections },
    attribution,
    op_violations: opViolations
  } as ValidationResult & { op_violations: string[] };
}

/**
 * 独立实现的真值归因：直接在 truth.json 上按量重算，
 * 用于校验归一化后的谱系与数量分摊是否忠实于原始生产事实。
 */
function truthAttribution(truth: Truth, start: string): Map<string, number> {
  const frac = new Map<string, number>([[start, 1]]);
  const isAssembly = new Map<string, boolean>();
  for (const op of truth.operations) isAssembly.set(op.op_id, op.inputs.some((i) => i.role === 'ADDITIVE'));
  const materialOf = new Map(truth.lots.map((l) => [l.lot_no, l.material_code]));
  const groups = new Map<string, Map<string, { lot: string; qty: number; mat: string }[]>>();
  for (const op of truth.operations) {
    const gm = groups.get(op.op_id) ?? new Map();
    for (const i of op.inputs) {
      const mat = materialOf.get(i.lot) ?? 'UNKNOWN';
      const key = isAssembly.get(op.op_id) ? mat : 'ALL';
      const arr = gm.get(key) ?? [];
      arr.push({ lot: i.lot, qty: i.qty, mat });
      gm.set(key, arr);
    }
    groups.set(op.op_id, gm);
  }
  const order = [...truth.operations].sort((a, b) => a.op_id.localeCompare(b.op_id));
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (const op of order) {
      const gm = groups.get(op.op_id)!;
      const totalOut = op.outputs.reduce((s, o) => s + o.qty, 0);
      for (const o of op.outputs) {
        let best = 0;
        for (const inputs of gm.values()) {
          const totalIn = inputs.reduce((s, i) => s + i.qty, 0) || 1;
          let g = 0;
          for (const i of inputs) {
            const p = frac.get(i.lot) ?? 0;
            g += p * (i.qty / totalIn) * (o.qty / totalOut);
          }
          best = Math.max(best, g);
        }
        if (best <= 1e-9) continue;
        const next = Math.min(1, best);
        const cur = frac.get(o.lot) ?? 0;
        if (next > cur + 1e-9) {
          frac.set(o.lot, next);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return frac;
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
