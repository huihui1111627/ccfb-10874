import { getDb } from '../db/index.js';

export interface SuspectResult {
  lots: { lot_no: string; reason: string; inspection_no: string; item: string; since: string }[];
  byInspection: Map<string, { lot: string; reason: string }>;
}

/**
 * 质检不合格自动标记可疑批次：
 *  - 不合格批次本身可疑（直接）
 *  - 下游所有子批（谱系后代）可疑（间接，原因写明来源）
 *  - 上游不受影响（原料不会因后续工序不合格而变可疑）
 */
export function markSuspectLots(): SuspectResult {
  const db = getDb();
  db.prepare(`UPDATE lots SET suspect = 0, suspect_reason = NULL`).run();
  const fails = db.prepare(`SELECT inspection_no, lot_no, item, measured_value, upper_limit, lower_limit, inspected_at FROM inspections WHERE result='FAIL' AND lot_no IS NOT NULL`).all() as {
    inspection_no: string; lot_no: string; item: string; measured_value: number; upper_limit: number; lower_limit: number; inspected_at: string;
  }[];
  const childRows = db.prepare(`SELECT DISTINCT parent_lot, child_lot FROM edges`).all() as { parent_lot: string; child_lot: string }[];
  const childrenOf = new Map<string, string[]>();
  for (const row of childRows) {
    const arr = childrenOf.get(row.parent_lot) ?? [];
    arr.push(row.child_lot);
    childrenOf.set(row.parent_lot, arr);
  }
  const mark = db.prepare(`UPDATE lots SET suspect = 1, suspect_reason = ? WHERE lot_no = ?`);

  const byInspection = new Map<string, { lot: string; reason: string }>();
  const lots: SuspectResult['lots'] = [];

  for (const f of fails) {
    byInspection.set(f.inspection_no, { lot: f.lot_no, reason: f.inspection_no });
    const direct = `质检不合格 ${f.inspection_no}（${f.item}=${f.measured_value}，规格 ${f.lower_limit}~${f.upper_limit}）`;
    mark.run(direct, f.lot_no);
    lots.push({ lot_no: f.lot_no, reason: direct, inspection_no: f.inspection_no, item: f.item, since: f.inspected_at });

    const seen = new Set<string>([f.lot_no]);
    let frontier = [f.lot_no];
    for (let depth = 0; depth < 8 && frontier.length; depth++) {
      const next: string[] = [];
      for (const p of frontier) {
        for (const c of childrenOf.get(p) ?? []) {
          if (seen.has(c)) continue;
          seen.add(c);
          next.push(c);
          const reasonStr = `受上游 ${f.lot_no} 质检不合格影响（${f.inspection_no}）`;
          mark.run(reasonStr, c);
          lots.push({ lot_no: c, reason: reasonStr, inspection_no: f.inspection_no, item: f.item, since: f.inspected_at });
        }
      }
      frontier = next;
    }
  }
  return { lots, byInspection };
}
