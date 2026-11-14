import { getDb } from '../db/index.js';
import type { DashboardStats } from '../../../shared/types.js';
import { STAGE_NAME, STAGE_ORDER } from '../../../shared/materials.js';

export function dashboardStats(): DashboardStats {
  const db = getDb();
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  // 原料是采购来的，不是本厂产出，统计产出构成时排除
  const byStageRows = db.prepare(`SELECT stage, COUNT(*) AS lots, SUM(CASE WHEN stage='CAST' AND uom='kg' THEN qty_produced/2.45 ELSE qty_produced END) AS qty FROM lots WHERE is_raw = 0 GROUP BY stage`).all() as { stage: string; lots: number; qty: number }[];
  const daily = db.prepare(`
    SELECT l.production_date AS date, SUM(CASE WHEN l.stage='FINAL' THEN l.qty_produced ELSE 0 END) AS qty
    FROM lots l
    WHERE EXISTS (SELECT 1 FROM lots x WHERE x.production_date = l.production_date AND x.stage='FINAL')
    GROUP BY l.production_date ORDER BY l.production_date
  `).all() as { date: string; qty: number }[];
  // event_time 存 UTC，按 +8 小时折算成车间本地日期
  const scrapDaily = db.prepare(`
    SELECT strftime('%Y-%m-%d', event_time, '+8 hours') AS date, SUM(scrap_qty) AS qty FROM operations
    WHERE stage='FINAL' GROUP BY date ORDER BY date
  `).all() as { date: string; qty: number }[];
  const scrapMap = new Map(scrapDaily.map((s) => [s.date, s.qty]));
  const range = db.prepare(`SELECT MIN(production_date) AS from_, MAX(production_date) AS to_ FROM lots`).get() as { from_: string; to_: string };
  const byStage = STAGE_ORDER.map((s) => {
    const r = byStageRows.find((x) => x.stage === s);
    return { stage: s, name: STAGE_NAME[s], lots: r?.lots ?? 0, qty: Math.round((r?.qty ?? 0) * 10) / 10 };
  });
  return {
    lots: one(`SELECT COUNT(*) AS n FROM lots`),
    raw_lots: one(`SELECT COUNT(*) AS n FROM lots WHERE is_raw = 1`),
    finished_lots: one(`SELECT COUNT(*) AS n FROM lots WHERE stage = 'FINAL'`),
    serials: one(`SELECT COUNT(*) AS n FROM serials`),
    shipments: one(`SELECT COUNT(*) AS n FROM shipments`),
    customers: one(`SELECT COUNT(DISTINCT customer_code) AS n FROM shipments`),
    edges: one(`SELECT COUNT(*) AS n FROM edges`),
    inspections: one(`SELECT COUNT(*) AS n FROM inspections`),
    failed_inspections: one(`SELECT COUNT(*) AS n FROM inspections WHERE result='FAIL'`),
    suspect_lots: one(`SELECT COUNT(*) AS n FROM lots WHERE suspect = 1`),
    date_range: { from: range.from_ ?? '', to: range.to_ ?? '' },
    by_stage: byStage,
    daily_output: daily.map((d) => ({ date: d.date, qty: Math.round(d.qty * 10) / 10, scrap: Math.round((scrapMap.get(d.date) ?? 0) * 10) / 10 }))
  };
}
