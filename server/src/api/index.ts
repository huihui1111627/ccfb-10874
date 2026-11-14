import express from 'express';
import cors from 'cors';
import { getDb } from '../db/index.js';
import { loadGraph, invalidateGraph } from '../trace/graph.js';
import { forwardTrace, backwardTraceBySerial, backwardTraceByLot, simulateRecall, customers } from '../trace/service.js';
import { markSuspectLots } from '../quality/suspect.js';
import { runIngest } from '../ingest/pipeline.js';
import { persistIngest } from '../ingest/persist.js';
import { validateAgainstTruth } from '../trace/validate.js';
import { buildEightD } from '../reports/eightd.js';
import { dashboardStats } from './stats.js';
import { STAGE_NAME } from '../../../shared/materials.js';

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    const db = getDb();
    const lots = db.prepare(`SELECT COUNT(*) AS n FROM lots`).get() as { n: number };
    res.json({ ok: true, lots: lots.n, ready: lots.n > 0 });
  });

  // ---------- 数据接入 ----------
  app.post('/api/ingest/run', (_req, res) => {
    try {
      const t0 = Date.now();
      const { result, runId } = runIngest();
      persistIngest(result, runId);
      markSuspectLots();
      invalidateGraph();
      res.json({
        run_id: runId, elapsed_ms: Date.now() - t0,
        counts: result.counts, issues: result.issues,
        files: result.files, time_stats: result.timeStats,
        mappings: summarizeMappings(result.mappings)
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get('/api/ingest/status', (_req, res) => {
    const db = getDb();
    const last = db.prepare(`SELECT run_id, run_at, counts_json FROM ingest_runs ORDER BY run_at DESC LIMIT 1`).get() as { run_id: string; run_at: string; counts_json: string } | undefined;
    const issues = db.prepare(`SELECT stage, severity, system, message, ref FROM issues ORDER BY CASE severity WHEN 'ERROR' THEN 0 WHEN 'WARN' THEN 1 ELSE 2 END`).all();
    const sev = db.prepare(`SELECT severity, COUNT(*) AS n FROM issues GROUP BY severity`).all();
    const mappings = db.prepare(`SELECT system, raw, normalized, confidence FROM code_mappings`).all();
    res.json({
      run: last ? { run_id: last.run_id, run_at: last.run_at, ...JSON.parse(last.counts_json) } : null,
      issues, severity_counts: sev, mappings
    });
  });

  app.get('/api/ingest/issues', (req, res) => {
    const db = getDb();
    const severity = req.query.severity as string | undefined;
    const stage = req.query.stage as string | undefined;
    let sql = `SELECT stage, severity, system, message, ref FROM issues`;
    const where: string[] = [];
    if (severity) where.push(`severity = '${severity.replace(/[^A-Z]/g, '')}'`);
    if (stage) where.push(`stage = '${stage.replace(/[^A-Z]/g, '')}'`);
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    res.json(db.prepare(sql).all());
  });

  app.get('/api/stats', (_req, res) => {
    res.json(dashboardStats());
  });

  // ---------- 批次谱系 ----------
  app.get('/api/lots', (req, res) => {
    const db = getDb();
    const q = (req.query.q as string | undefined)?.trim();
    const stage = req.query.stage as string | undefined;
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const cond: string[] = [];
    if (q) cond.push(`(lot_no LIKE '%${q.replace(/'/g, '')}%' OR work_order LIKE '%${q.replace(/'/g, '')}%' OR material_name LIKE '%${q.replace(/'/g, '')}%')`);
    if (stage) cond.push(`stage = '${stage.replace(/[^A-Z]/g, '')}'`);
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT lot_no, material_code, material_name, stage, uom, qty_produced, qty_remaining, production_date, work_order, supplier, is_raw, suspect, suspect_reason FROM lots ${where} ORDER BY production_date DESC, lot_no DESC LIMIT ${limit}`).all();
    res.json({ rows, total: (db.prepare(`SELECT COUNT(*) AS n FROM lots ${where}`).get() as { n: number }).n });
  });

  app.get('/api/lots/:lot', (req, res) => {
    const db = getDb();
    const lot = db.prepare(`SELECT * FROM lots WHERE lot_no = ?`).get(req.params.lot) as Record<string, unknown> | undefined;
    if (!lot) return res.status(404).json({ error: '批次不存在' });
    const graph = loadGraph();
    const parents = (graph.in.get(req.params.lot) ?? []).map((e) => ({
      ...e, material_name: graph.lots.get(e.parent_lot)?.material_name ?? '', stage_name: STAGE_NAME[e.stage as keyof typeof STAGE_NAME]
    }));
    const children = (graph.out.get(req.params.lot) ?? []).map((e) => ({
      ...e, material_name: graph.lots.get(e.child_lot)?.material_name ?? '', stage_name: STAGE_NAME[e.stage as keyof typeof STAGE_NAME]
    }));
    const inspections = db.prepare(`SELECT inspection_no, inspection_type, item, measured_value, lower_limit, upper_limit, result, inspected_at FROM inspections WHERE lot_no = ?`).all(req.params.lot);
    const ships = db.prepare(`SELECT s.shipment_no, s.customer_name, s.ship_date, sl.qty FROM shipment_lines sl JOIN shipments s USING(shipment_no) WHERE sl.lot_no = ?`).all(req.params.lot);
    res.json({ lot, parents, children, inspections, shipments: ships });
  });

  app.get('/api/genealogy/:lot', (req, res) => {
    const graph = loadGraph();
    const lot = req.params.lot;
    if (!graph.lots.has(lot)) return res.status(404).json({ error: '批次不存在' });
    const depth = Math.min(Number(req.query.depth ?? 8), 12);
    const dir = (req.query.dir as string) ?? 'both';
    const nodes = new Set<string>([lot]);
    const edges: { parent: string; child: string; op_id: string; stage: string; flow_type: string; qty_consumed: number; weight: number }[] = [];
    const pushEdges = (from: string, forward: boolean, level: number) => {
      if (level <= 0) return;
      const list = forward ? graph.out.get(from) ?? [] : graph.in.get(from) ?? [];
      for (const e of list) {
        const other = forward ? e.child_lot : e.parent_lot;
        edges.push({ parent: e.parent_lot, child: e.child_lot, op_id: e.op_id, stage: e.stage, flow_type: e.flow_type, qty_consumed: e.qty_consumed, weight: e.weight });
        if (!nodes.has(other)) {
          nodes.add(other);
          pushEdges(other, forward, level - 1);
        }
      }
    };
    if (dir === 'forward' || dir === 'both') pushEdges(lot, true, depth);
    if (dir === 'backward' || dir === 'both') pushEdges(lot, false, depth);
    const nodeList = [...nodes].map((n) => {
      const l = graph.lots.get(n)!;
      return {
        lot_no: l.lot_no, material_name: l.material_name, material_code: l.material_code, stage: l.stage,
        stage_name: STAGE_NAME[l.stage as keyof typeof STAGE_NAME], qty_produced: l.qty_produced, qty_remaining: l.qty_remaining,
        production_date: l.production_date, work_order: l.work_order, suspect: !!l.suspect,
        suspect_reason: l.suspect_reason, is_raw: !!l.is_raw, is_focus: n === lot
      };
    });
    const edgeSeen = new Set<string>();
    const uniqueEdges = edges.filter((e) => {
      const k = `${e.op_id}|${e.parent}|${e.child}`;
      if (edgeSeen.has(k)) return false;
      edgeSeen.add(k);
      return true;
    });
    res.json({ focus: lot, nodes: nodeList, edges: uniqueEdges });
  });

  // ---------- 正向追溯 ----------
  app.post('/api/trace/forward', (req, res) => {
    try {
      const lot = String(req.body?.lot ?? '');
      if (!lot) return res.status(400).json({ error: '缺少批次号 lot' });
      res.json(forwardTrace(lot));
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  // ---------- 反向追溯 ----------
  app.post('/api/trace/backward', (req, res) => {
    try {
      const serial = req.body?.serial ? String(req.body.serial) : '';
      const lot = req.body?.lot ? String(req.body.lot) : '';
      if (serial) return res.json(backwardTraceBySerial(serial));
      if (lot) return res.json(backwardTraceByLot(lot));
      res.status(400).json({ error: '需要 serial 或 lot' });
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  app.get('/api/serials/lookup/:serial', (req, res) => {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM serials WHERE serial_no = ?`).get(req.params.serial);
    if (!row) return res.status(404).json({ error: '序列号不存在' });
    res.json(row);
  });

  app.get('/api/serials', (req, res) => {
    const db = getDb();
    const q = (req.query.q as string | undefined) ?? '';
    const rows = db.prepare(`SELECT serial_no, lot_no, status, shipment_no, customer_code FROM serials WHERE serial_no LIKE '%${q.replace(/'/g, '')}%' ORDER BY serial_no LIMIT 40`).all();
    res.json(rows);
  });

  // ---------- 质检 / 可疑 ----------
  app.get('/api/quality/failures', (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`SELECT inspection_no, batch_code, lot_no, inspection_type, item, measured_value, lower_limit, upper_limit, result, inspected_at FROM inspections WHERE result='FAIL' ORDER BY inspected_at`).all() as {
      inspection_no: string; batch_code: string; lot_no: string; inspection_type: string; item: string;
      measured_value: number; lower_limit: number; upper_limit: number; result: string; inspected_at: string;
    }[];
    const affected = db.prepare(`SELECT lot_no, material_name, stage, suspect_reason FROM lots WHERE suspect = 1 ORDER BY lot_no`).all();
    // 每个不合格批次的预估影响范围（下游成品/发货/客户）
    const failures = rows.map((r) => {
      if (!r.lot_no) return { ...r, impact: null };
      try {
        const f = forwardTrace(r.lot_no);
        return {
          ...r,
          impact: {
            finished_lots: f.finished_lots.length,
            shipped_qty: f.totals.shipped_qty,
            in_stock_qty: f.totals.in_stock_qty,
            customers: f.affected_customers.map((c) => ({ code: c.code, name: c.name, qty: c.qty })),
            suspect_lots: f.suspect_lots.length
          }
        };
      } catch {
        return { ...r, impact: null };
      }
    });
    res.json({ failures, suspect_lots: affected, suspect_count: affected.length });
  });

  app.get('/api/quality/suspects', (_req, res) => {
    const db = getDb();
    res.json(db.prepare(`SELECT lot_no, material_name, stage, qty_produced, qty_remaining, suspect_reason, production_date FROM lots WHERE suspect = 1 ORDER BY production_date`).all());
  });

  // ---------- 召回模拟 ----------
  app.post('/api/recall/simulate', (req, res) => {
    try {
      res.json(simulateRecall({ lot: req.body?.lot, serial: req.body?.serial }));
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  app.get('/api/customers', (_req, res) => {
    res.json(customers());
  });

  // ---------- 8D 报告 ----------
  app.post('/api/reports/8d', async (req, res) => {
    try {
      const { lot, serial, complaint_no, customer } = req.body ?? {};
      const { report, docxBuffer, markdown } = await buildEightD({ lot, serial, complaintNo: complaint_no, customerCode: customer });
      res.json({ report, markdown, file: `8D-${report.header.complaint_no}.docx`, download: `/api/reports/8d/download?lot=${encodeURIComponent(lot ?? '')}&serial=${encodeURIComponent(serial ?? '')}&complaint_no=${encodeURIComponent(complaint_no ?? '')}&customer=${encodeURIComponent(customer ?? '')}`, bytes: docxBuffer.length });
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  app.get('/api/reports/8d/download', async (req, res) => {
    try {
      const { report, docxBuffer } = await buildEightD({
        lot: req.query.lot as string | undefined, serial: req.query.serial as string | undefined,
        complaintNo: req.query.complaint_no as string | undefined, customerCode: req.query.customer as string | undefined
      });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="8D-${report.header.complaint_no}.docx"`);
      res.send(docxBuffer);
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  // ---------- 校验 ----------
  app.get('/api/validate', (_req, res) => {
    try {
      res.json(validateAgainstTruth());
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get('/api/truth/complaint', (_req, res) => {
    const db = getDb();
    const row = db.prepare(`SELECT value FROM meta WHERE key='complaint'`).get() as { value: string } | undefined;
    res.json(row ? JSON.parse(row.value) : null);
  });

  return app;
}

function summarizeMappings(m: { system: string; raw: string; normalized: string; confidence: string }[]) {
  const map = new Map<string, { system: string; values: { raw: string; normalized: string; confidence: string; count: number }[] }>();
  for (const x of m) {
    const cur = map.get(x.system) ?? { system: x.system, values: [] };
    const existing = cur.values.find((v) => v.raw === x.raw && v.normalized === x.normalized);
    if (existing) existing.count++;
    else cur.values.push({ raw: x.raw, normalized: x.normalized, confidence: x.confidence, count: 1 });
    map.set(x.system, cur);
  }
  return [...map.values()];
}
