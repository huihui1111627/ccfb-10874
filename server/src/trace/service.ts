import { getDb } from '../db/index.js';
import { STAGE_NAME } from '../../../shared/materials.js';
import type {
  BackwardTrace, Customer, ForwardTrace, RecallPlan, TraceNode, TraceHop, StageCode, RecallShipment
} from '../../../shared/types.js';
import { loadGraph, propagateFractions, type InMemoryGraph, type EdgeRow, type LotRow } from './graph.js';

const AS_OF = '2025-10-01';
const UNIT_COST = 268;        // 单件制造成本（元）
const FREIGHT_PER_UNIT = 42;  // 召回物流单件
const REWORK_PER_UNIT = 85;   // 检测+返修单件
const SCRAP_RESIDUAL = 0.15;  // 报废残值率

export interface ShipmentHit {
  shipment_no: string;
  customer_code: string;
  customer_name: string;
  ship_date: string;
  destination: string;
  qty: number;
  serials: string[];
}

function shipmentsForLots(lots: string[]): Map<string, ShipmentHit[]> {
  const db = getDb();
  const result = new Map<string, ShipmentHit[]>();
  if (!lots.length) return result;
  const placeholders = lots.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT sl.lot_no, sl.qty, sl.serials_json, s.shipment_no, s.customer_code, s.customer_name, s.ship_date, s.destination
    FROM shipment_lines sl JOIN shipments s ON s.shipment_no = sl.shipment_no
    WHERE sl.lot_no IN (${placeholders})
  `).all(...lots) as {
    lot_no: string; qty: number; serials_json: string; shipment_no: string; customer_code: string;
    customer_name: string; ship_date: string; destination: string;
  }[];
  for (const r of rows) {
    const arr = result.get(r.lot_no) ?? [];
    arr.push({
      shipment_no: r.shipment_no, customer_code: r.customer_code, customer_name: r.customer_name,
      ship_date: r.ship_date, destination: r.destination, qty: r.qty,
      serials: JSON.parse(r.serials_json) as string[]
    });
    result.set(r.lot_no, arr);
  }
  return result;
}

function customerName(code: string): string {
  const db = getDb();
  const row = db.prepare(`SELECT DISTINCT customer_name FROM shipments WHERE customer_code = ?`).get(code) as { customer_name: string } | undefined;
  return row?.customer_name ?? code;
}

function lotNode(lot: LotRow, fraction: number, depth: number, viaOp: string | null, graph: InMemoryGraph): TraceNode {
  const db = getDb();
  const incoming = db.prepare(`SELECT qty_consumed FROM edges WHERE child_lot = ? AND op_id = ?`).get(lot.lot_no, viaOp ?? '') as { qty_consumed: number } | undefined;
  return {
    lot_no: lot.lot_no,
    material_code: lot.material_code,
    material_name: lot.material_name,
    stage: lot.stage as StageCode,
    depth,
    qty_consumed: incoming?.qty_consumed ?? 0,
    qty_produced: lot.qty_produced,
    event_time: graph.lots.get(lot.lot_no)?.production_date ?? '',
    work_order: lot.work_order,
    flow_type: viaOp ? (graph.ops.get(viaOp)?.flow_type as TraceNode['flow_type']) ?? 'NORMAL' : 'NORMAL',
    suspect: !!lot.suspect,
    quality_flags: viaOp ? (JSON.parse(graph.ops.get(viaOp)?.quality_flags ?? '[]') as string[]) : [],
    fraction
  } as TraceNode & { fraction: number };
}

export function forwardTrace(rawLot: string): ForwardTrace {
  const t0 = Date.now();
  const db = getDb();
  const graph = loadGraph();
  const start = graph.lots.get(rawLot);
  if (!start) throw new Error(`批次不存在: ${rawLot}`);
  const fractions = propagateFractions([rawLot], graph);
  const nodes: TraceNode[] = [];
  for (const [lotNo, info] of fractions) {
    const lot = graph.lots.get(lotNo);
    if (!lot) continue;
    nodes.push(lotNode(lot, info.fraction, info.depth, info.viaOp, graph));
  }
  nodes.sort((a, b) => a.depth - b.depth || (a.event_time || '').localeCompare(b.event_time || ''));

  const finishedLots = nodes.filter((n) => n.stage === 'FINAL');
  const finishedIds = finishedLots.map((f) => f.lot_no);
  const shipMap = shipmentsForLots(finishedIds);

  const finished = finishedLots.map((f) => {
    const frac = (f as TraceNode & { fraction: number }).fraction;
    const ships = shipMap.get(f.lot_no) ?? [];
    return {
      lot_no: f.lot_no,
      material_name: f.material_name,
      qty_produced: f.qty_produced,
      attributable_qty: round(f.qty_produced * frac, 1),
      fraction: round(frac, 4),
      /** 贡献 < 0.2% 属数值噪声，UI 可折叠 */
      minor: frac < 0.002,
      shipments: ships
        .map((s) => ({
          shipment_no: s.shipment_no, customer_code: s.customer_code, customer_name: s.customer_name,
          ship_date: s.ship_date, qty: round(s.qty * frac, 1), serials: s.serials
        }))
    };
  });

  const customerAgg = new Map<string, { code: string; name: string; qty: number; shipments: Set<string> }>();
  for (const f of finished) {
    for (const s of f.shipments) {
      const cur = customerAgg.get(s.customer_code) ?? { code: s.customer_code, name: s.customer_name, qty: 0, shipments: new Set<string>() };
      cur.qty = round(cur.qty + s.qty, 1);
      cur.shipments.add(s.shipment_no);
      customerAgg.set(s.customer_code, cur);
    }
  }

  const shippedQty = round(finished.reduce((s, f) => s + f.shipments.reduce((x, y) => x + y.qty, 0), 0), 1);
  const totalFinished = round(finished.reduce((s, f) => s + f.attributable_qty, 0), 1);
  const suspectLots = [...fractions.entries()].filter(([lotNo]) => graph.lots.get(lotNo)?.suspect).map(([lotNo]) => lotNo);

  return {
    raw_lot: rawLot,
    nodes,
    finished_lots: finished,
    affected_customers: [...customerAgg.values()].map((c) => ({
      code: c.code, name: c.name, qty: round(c.qty, 1), shipments: c.shipments.size
    })).sort((a, b) => b.qty - a.qty),
    totals: {
      finished_qty: totalFinished,
      shipped_qty: shippedQty,
      in_stock_qty: round(totalFinished - shippedQty, 1),
      customers: customerAgg.size
    },
    suspect_lots: suspectLots,
    serials_by_lot: finished.map((f) => {
      const all = db.prepare(`SELECT serial_no, status FROM serials WHERE lot_no = ?`).all(f.lot_no) as { serial_no: string; status: string }[];
      return {
        lot_no: f.lot_no,
        serials: all.map((x) => x.serial_no),
        shipped: all.filter((x) => x.status === 'SHIPPED').length
      };
    }),
    elapsed_ms: Date.now() - t0
  };
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// ==================== 反向追溯 ====================

export function backwardTraceByLot(finLot: string): BackwardTrace {
  const t0 = Date.now();
  const graph = loadGraph();
  const lot = graph.lots.get(finLot);
  if (!lot) throw new Error(`批次不存在: ${finLot}`);
  const result = traceBack(finLot, graph);
  const ships = shipmentsForLots([finLot]).get(finLot) ?? [];
  return {
    serial_no: '',
    lot_no: finLot,
    paths: result.paths,
    raw_lots: result.paths.map((p) => p.raw_lot),
    shipments: ships.map((s) => ({ shipment_no: s.shipment_no, customer_name: s.customer_name, ship_date: s.ship_date, qty: s.qty })),
    hops: result.hops,
    elapsed_ms: Date.now() - t0
  };
}

export function backwardTraceBySerial(serial: string): BackwardTrace {
  const t0 = Date.now();
  const db = getDb();
  const row = db.prepare(`SELECT serial_no, lot_no, produced_at, shipment_no, customer_code, status FROM serials WHERE serial_no = ?`).get(serial) as
    { serial_no: string; lot_no: string; produced_at: string; shipment_no: string | null; customer_code: string | null; status: string } | undefined;
  if (!row) throw new Error(`序列号不存在: ${serial}`);
  const graph = loadGraph();
  const lot = graph.lots.get(row.lot_no);
  if (!lot) throw new Error(`序列号 ${serial} 对应的批次 ${row.lot_no} 不存在`);
  const result = traceBack(row.lot_no, graph);
  const ships = shipmentsForLots([row.lot_no]).get(row.lot_no) ?? [];
  return {
    serial_no: serial,
    lot_no: row.lot_no,
    paths: result.paths,
    raw_lots: result.paths.map((p) => p.raw_lot),
    shipments: ships.map((s) => ({ shipment_no: s.shipment_no, customer_name: s.customer_name, ship_date: s.ship_date, qty: s.qty })),
    hops: result.hops,
    elapsed_ms: Date.now() - t0
  };
}

function traceBack(finLot: string, graph: InMemoryGraph): {
  paths: BackwardTrace['paths'];
  hops: TraceHop[];
} {
  // 反向传播：每个批次的“占成品比例”
  const share = new Map<string, number>([[finLot, 1]]);
  const visitedOps = new Set<string>();
  const queue: string[] = [finLot];
  const hopsSeen = new Set<string>();
  const hops: TraceHop[] = [];
  let guard = 0;
  while (queue.length && guard++ < 5000) {
    const cur = queue.shift()!;
    const curShare = share.get(cur) ?? 0;
    const incoming = graph.in.get(cur) ?? [];
    // 同一工序的多个父批：按 weight 分配到该子批
    const byOp = new Map<string, EdgeRow[]>();
    for (const e of incoming) {
      const arr = byOp.get(e.op_id) ?? [];
      arr.push(e);
      byOp.set(e.op_id, arr);
    }
    for (const [opId, edges] of byOp) {
      const op = graph.ops.get(opId);
      if (!op) continue;
      const sumW = edges.reduce((s, e) => s + e.weight, 0) || 1;
      for (const e of edges) {
        const portion = (e.weight / sumW) * curShare;
        const prev = share.get(e.parent_lot) ?? 0;
        // 同一父批可能经多条路径过来，取最大贡献（数量口径）避免跨物料通道相加
        share.set(e.parent_lot, Math.max(prev, portion));
        queue.push(e.parent_lot);
      }
      if (!hopsSeen.has(opId)) {
        hopsSeen.add(opId);
        const sumPerGroup = new Map<string, number>();
        for (const e of edges) sumPerGroup.set(e.group_key, (sumPerGroup.get(e.group_key) ?? 0) + e.weight);
        hops.push({
          op_id: opId,
          stage: op.stage as StageCode,
          stage_name: STAGE_NAME[op.stage as StageCode],
          work_order: op.work_order,
          equipment: op.equipment,
          operator: op.operator,
          event_time: op.event_time,
          flow_type: op.flow_type as TraceHop['flow_type'],
          quality_flags: JSON.parse(op.quality_flags) as string[],
          params: JSON.parse(op.params_json) as Record<string, string | number>,
          inputs: graph.parentsByOp.get(opId)?.map((p) => {
            const pe = (graph.in.get(cur) ?? []).find((x) => x.op_id === opId && x.parent_lot === p);
            const pl = graph.lots.get(p);
            return {
              lot_no: p, material_name: pl?.material_name ?? '', qty: pe?.qty_consumed ?? 0,
              uom: pl?.uom ?? '', role: (pe?.role ?? 'MAIN') as TraceHop['inputs'][number]['role'],
              weight: pe?.weight ?? 0
            };
          }) ?? [],
          outputs: graph.childrenByOp.get(opId)?.map((c) => {
            const cl = graph.lots.get(c);
            const ce = (graph.in.get(c) ?? []).find((x) => x.op_id === opId);
            return { lot_no: c, material_name: cl?.material_name ?? '', qty: cl?.qty_produced ?? 0, uom: cl?.uom ?? '' };
          }) ?? [],
          scrap_qty: op.scrap_qty
        });
      }
      visitedOps.add(opId);
    }
  }

  // 每个原料批取一条代表路径（回溯时贪心选权重最大的父边）
  const rawLots = [...share.entries()].filter(([lotNo]) => graph.lots.get(lotNo)?.is_raw);
  const paths: BackwardTrace['paths'] = rawLots.map(([rawLot, weight]) => {
    const steps: BackwardTrace['paths'][number]['steps'] = [];
    let cur = finLot;
    const seenLots = new Set<string>();
    while (cur !== rawLot && !seenLots.has(cur)) {
      seenLots.add(cur);
      const lot = graph.lots.get(cur);
      const incoming = graph.in.get(cur) ?? [];
      if (!incoming.length) break;
      // 优先选择通向目标原料批的父边，否则选权重最大的
      const viaRaw = incoming.filter((e) => {
        if (e.parent_lot === rawLot) return true;
        const anc = ancestorsOf(e.parent_lot, graph, 8);
        return anc.has(rawLot);
      });
      const pool = viaRaw.length ? viaRaw : incoming;
      const chosen = pool.reduce((a, b) => (b.weight > a.weight ? b : a), pool[0]);
      const op = graph.ops.get(chosen.op_id);
      if (op) {
        steps.unshift({
          lot_no: cur,
          material_name: lot?.material_name ?? '',
          stage: op.stage as StageCode,
          work_order: op.work_order,
          equipment: op.equipment,
          operator: op.operator,
          event_time: op.event_time,
          flow_type: op.flow_type as TraceHop['flow_type'],
          params: JSON.parse(op.params_json) as Record<string, string | number>,
          quality_flags: JSON.parse(op.quality_flags) as string[]
        });
      }
      cur = chosen.parent_lot;
    }
    return {
      raw_lot: rawLot,
      supplier: graph.lots.get(rawLot)?.supplier ?? null,
      material_name: graph.lots.get(rawLot)?.material_name ?? '',
      weight: round(weight, 4),
      steps
    };
  }).sort((a, b) => b.weight - a.weight);

  hops.sort((a, b) => a.event_time.localeCompare(b.event_time));
  return { paths, hops };
}

function ancestorsOf(lot: string, graph: InMemoryGraph, depth: number, seen = new Set<string>()): Set<string> {
  if (depth <= 0 || seen.has(lot)) return seen;
  seen.add(lot);
  for (const e of graph.in.get(lot) ?? []) ancestorsOf(e.parent_lot, graph, depth - 1, seen);
  return seen;
}

// ==================== 召回模拟 ====================

export function simulateRecall(input: { lot?: string; serial?: string }): RecallPlan {
  const t0 = Date.now();
  const db = getDb();
  let lotNo = input.lot ?? '';
  let kind: RecallPlan['input_kind'] = 'RAW';
  if (input.serial) {
    const row = db.prepare(`SELECT lot_no FROM serials WHERE serial_no = ?`).get(input.serial) as { lot_no: string } | undefined;
    if (!row) throw new Error(`序列号不存在: ${input.serial}`);
    lotNo = row.lot_no;
    kind = 'SERIAL';
  } else {
    const lot = db.prepare(`SELECT stage FROM lots WHERE lot_no = ?`).get(lotNo) as { stage: string } | undefined;
    if (!lot) throw new Error(`批次不存在: ${lotNo}`);
    kind = lot.stage === 'FINAL' ? 'FINISHED' : 'RAW';
  }
  const graph = loadGraph();
  const frac = propagateFractions([lotNo], graph);
  const affectedLots = [...frac.entries()];
  const finished = affectedLots.filter(([l]) => graph.lots.get(l)?.stage === 'FINAL');
  const shipMap = shipmentsForLots(finished.map(([l]) => l));

  const shipmentAgg = new Map<string, RecallShipment>();
  let totalShipped = 0;
  let totalAffected = 0;
  for (const [finLot, info] of finished) {
    // 贡献比例低于 0.2% 的成品批属于数值噪声，不计入召回范围
    if (info.fraction < 0.002) continue;
    const ships = shipMap.get(finLot) ?? [];
    for (const s of ships) {
      const key = s.shipment_no;
      const cur = shipmentAgg.get(key) ?? {
        shipment_no: s.shipment_no, customer_code: s.customer_code, customer_name: s.customer_name,
        ship_date: s.ship_date, destination: s.destination, affected_qty: 0, lot_qty: 0,
        serials: [], lots: [], days_since_ship: dayDiff(s.ship_date, AS_OF), priority: 'C'
      };
      cur.affected_qty = round(cur.affected_qty + s.qty * info.fraction, 1);
      cur.lot_qty = round(cur.lot_qty + s.qty, 1);
      cur.serials.push(...s.serials);
      cur.lots.push({ lot_no: finLot, qty: round(s.qty, 1), fraction: round(info.fraction, 3), attributable: round(s.qty * info.fraction, 1) });
      shipmentAgg.set(key, cur);
      totalShipped = round(totalShipped + s.qty, 1);
      totalAffected = round(totalAffected + s.qty * info.fraction, 1);
    }
  }
  for (const s of shipmentAgg.values()) {
    s.priority = s.days_since_ship <= 30 ? 'A' : s.days_since_ship <= 90 ? 'B' : 'C';
    s.serials.sort();
  }

  // 未发货库存 + 报废
  // 安全件默认按“整批召回”：批次一旦混入可疑料，序列号层面无法再拆分
  let inStock = 0;
  let inStockAttr = 0;
  let scrap = 0;
  const blocked: RecallPlan['blocked_inventory'] = [];
  for (const [lotNo2, info] of affectedLots) {
    const lot = graph.lots.get(lotNo2);
    if (!lot) continue;
    if (lot.stage === 'FINAL') {
      if (lot.qty_remaining > 0.5) {
        inStock = round(inStock + lot.qty_remaining, 1);
        blocked.push({ lot_no: lotNo2, material_name: lot.material_name, qty: round(lot.qty_remaining, 1), location: 'FG-A01' });
      }
      inStockAttr = round(inStockAttr + lot.qty_remaining * info.fraction, 1);
    }
    const scrapRows = db.prepare(`SELECT e.op_id, e.scrap_share, o.scrap_qty, o.scrap_uom FROM edges e JOIN operations o ON o.op_id = e.op_id WHERE e.parent_lot = ? AND e.scrap_share > 0`).all(lotNo2) as { op_id: string; scrap_share: number; scrap_qty: number; scrap_uom: string }[];
    for (const r of scrapRows) {
      scrap = round(scrap + r.scrap_share * info.fraction, 1);
    }
  }
  blocked.sort((a, b) => b.qty - a.qty);

  // 成本：保守口径（召回全部已发批次 + 拦截全部库存）
  const totalConservative = [...shipmentAgg.values()].reduce((s, x) => s + x.lot_qty, 0);
  const freight = round(totalConservative * FREIGHT_PER_UNIT, 0);
  const rework = round((totalConservative + inStock) * REWORK_PER_UNIT, 0);
  const scrapCost = round((scrap > 0 ? Math.min(scrap, totalConservative * 0.15) : 0) * UNIT_COST * (1 - SCRAP_RESIDUAL), 0);
  const total = freight + rework + scrapCost;
  const costAttr = round(totalAffected * FREIGHT_PER_UNIT + (totalAffected + inStockAttr) * REWORK_PER_UNIT, 0);

  const suspectLots = affectedLots.filter(([l]) => graph.lots.get(l)?.suspect).map(([l]) => l);
  return {
    input_lot: lotNo,
    input_kind: kind,
    suspect_lots: suspectLots,
    shipments: [...shipmentAgg.values()].sort((a, b) => a.days_since_ship - b.days_since_ship),
    total_affected_qty: totalAffected,
    total_conservative_qty: round(totalConservative, 1),
    total_shipped_qty: totalShipped,
    in_stock_qty: inStock,
    in_stock_attributable_qty: inStockAttr,
    scrap_qty: scrap,
    cost_estimate: { unit_recall_cost: UNIT_COST, freight, rework, scrap: scrapCost, total },
    cost_attributable: costAttr,
    blocked_inventory: blocked,
    elapsed_ms: Date.now() - t0
  };
}

export function dayDiff(from: string, to: string): number {
  return Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000));
}




export function setMeta(key: string, value: string): void {
  getDb().prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

export function customers(): Customer[] {
  const db = getDb();
  return db.prepare(`SELECT DISTINCT customer_code AS code, customer_name AS name FROM shipments ORDER BY customer_code`).all() as Customer[];
}
