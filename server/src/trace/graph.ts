import { getDb } from '../db/index.js';

export interface EdgeRow {
  op_id: string;
  parent_lot: string;
  child_lot: string;
  role: string;
  qty_consumed: number;
  qty_allocated: number;
  scrap_share: number;
  weight: number;
  group_key: string;
  event_time: string;
  stage: string;
  flow_type: string;
}

export interface OpRow {
  op_id: string;
  work_order: string;
  stage: string;
  item_code: string;
  alloc_mode: string;
  equipment: string;
  operator: string;
  event_time: string;
  source_time: string;
  source_system: string;
  flow_type: string;
  scrap_qty: number;
  scrap_uom: string;
  params_json: string;
  quality_flags: string;
}

export interface LotRow {
  lot_no: string;
  mes_lot: string;
  material_code: string;
  material_name: string;
  stage: string;
  uom: string;
  qty_produced: number;
  qty_remaining: number;
  production_date: string;
  work_order: string;
  supplier: string | null;
  is_raw: number;
  suspect: number;
  suspect_reason: string | null;
}

export interface InMemoryGraph {
  lots: Map<string, LotRow>;
  ops: Map<string, OpRow>;
  edges: EdgeRow[];
  out: Map<string, EdgeRow[]>;
  in: Map<string, EdgeRow[]>;
  childrenByOp: Map<string, string[]>;
  parentsByOp: Map<string, string[]>;
}

let cache: InMemoryGraph | null = null;

export function invalidateGraph(): void {
  cache = null;
}

export function loadGraph(): InMemoryGraph {
  if (cache) return cache;
  const db = getDb();
  const lots = new Map<string, LotRow>();
  for (const l of db.prepare(`SELECT * FROM lots`).all() as LotRow[]) lots.set(l.lot_no, l);
  const ops = new Map<string, OpRow>();
  for (const o of db.prepare(`SELECT * FROM operations`).all() as OpRow[]) ops.set(o.op_id, o);
  const edges = db.prepare(`SELECT * FROM edges ORDER BY event_time, op_id`).all() as EdgeRow[];
  const out = new Map<string, EdgeRow[]>();
  const inMap = new Map<string, EdgeRow[]>();
  const childrenByOp = new Map<string, string[]>();
  const parentsByOp = new Map<string, string[]>();
  for (const e of edges) {
    (out.get(e.parent_lot) ?? out.set(e.parent_lot, []).get(e.parent_lot)!).push(e);
    (inMap.get(e.child_lot) ?? inMap.set(e.child_lot, []).get(e.child_lot)!).push(e);
    const c = childrenByOp.get(e.op_id) ?? [];
    if (!c.includes(e.child_lot)) c.push(e.child_lot);
    childrenByOp.set(e.op_id, c);
    const p = parentsByOp.get(e.op_id) ?? [];
    if (!p.includes(e.parent_lot)) p.push(e.parent_lot);
    parentsByOp.set(e.op_id, p);
  }
  cache = { lots, ops, edges, out, in: inMap, childrenByOp, parentsByOp };
  return cache;
}

/**
 * 正向传播：计算起始批次对每个下游批次的“受影响比例”。
 * 规则：
 *  - 同一工序同一物料组内，各父批按 weight 归一后相加（合批场景）
 *  - 跨物料组取最大值（装配时本体/密封件/活塞是并行通道，
 *    某原料只能经其中一条通道影响成品，不能相加）
 *  - 返工可能形成环，跑有限轮次直到收敛
 */
export function propagateFractions(startLots: string[], graph: InMemoryGraph): Map<string, { fraction: number; depth: number; viaOp: string | null; firstSeen: string }> {
  const result = new Map<string, { fraction: number; depth: number; viaOp: string | null; firstSeen: string }>();
  for (const lot of startLots) {
    result.set(lot, { fraction: 1, depth: 0, viaOp: null, firstSeen: graph.lots.get(lot)?.production_date ?? '' });
  }

  const groupsByOp = new Map<string, Map<string, EdgeRow[]>>();
  for (const e of graph.edges) {
    const opGroups = groupsByOp.get(e.op_id) ?? new Map<string, EdgeRow[]>();
    const g = opGroups.get(e.group_key) ?? [];
    g.push(e);
    opGroups.set(e.group_key, g);
    groupsByOp.set(e.op_id, opGroups);
  }
  const groupSum = new Map<string, number>();
  for (const [opId, groups] of groupsByOp) {
    for (const [gk, edges] of groups) {
      groupSum.set(`${opId}|${gk}`, edges.reduce((s, e) => s + e.weight, 0));
    }
  }

  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (const [opId, groups] of groupsByOp) {
      const op = graph.ops.get(opId);
      if (!op) continue;
      for (const child of graph.childrenByOp.get(opId) ?? []) {
        let best: { fraction: number; depth: number; viaOp: string } | null = null;
        for (const [gk, edges] of groups) {
          const sum = groupSum.get(`${opId}|${gk}`) ?? 1;
          let groupFraction = 0;
          let groupDepth = 0;
          for (const e of edges) {
            if (e.child_lot !== child) continue;
            const parent = result.get(e.parent_lot);
            if (!parent) continue;
            groupFraction += parent.fraction * (e.weight / (sum || 1));
            groupDepth = Math.max(groupDepth, parent.depth);
          }
          if (groupFraction <= 1e-9) continue;
          const cand = { fraction: Math.min(1, groupFraction), depth: groupDepth + 1, viaOp: opId };
          if (!best || cand.fraction > best.fraction + 1e-9) best = cand;
        }
        if (!best) continue;
        const cur = result.get(child);
        if (!cur) {
          result.set(child, { ...best, firstSeen: op.event_time });
          changed = true;
        } else if (best.fraction > cur.fraction + 1e-9 || (Math.abs(best.fraction - cur.fraction) <= 1e-9 && best.depth < cur.depth)) {
          cur.fraction = best.fraction;
          cur.depth = best.depth;
          cur.viaOp = best.viaOp;
          cur.firstSeen = op.event_time;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return result;
}
