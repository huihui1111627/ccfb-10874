import { getDb } from '../db/index.js';
import type { IngestResult } from './pipeline.js';

export function persistIngest(r: IngestResult, runId: string): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM lots`).run();
    db.prepare(`DELETE FROM operations`).run();
    db.prepare(`DELETE FROM op_inputs`).run();
    db.prepare(`DELETE FROM op_outputs`).run();
    db.prepare(`DELETE FROM edges`).run();
    db.prepare(`DELETE FROM serials`).run();
    db.prepare(`DELETE FROM shipments`).run();
    db.prepare(`DELETE FROM shipment_lines`).run();
    db.prepare(`DELETE FROM inspections`).run();
    db.prepare(`DELETE FROM issues`).run();
    db.prepare(`DELETE FROM code_mappings`).run();
    db.prepare(`DELETE FROM ingest_runs`).run();

    const insLot = db.prepare(`INSERT INTO lots (lot_no, mes_lot, material_code, material_name, stage, uom, qty_produced, qty_remaining, production_date, work_order, supplier, is_raw, source_system, suspect, suspect_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const l of r.lots.values()) {
      insLot.run(l.lot_no, l.lot_no.replace(/^[CMAF]/, ''), l.material_code, l.material_name, l.stage, l.uom,
        l.qty_produced, l.qty_remaining, l.production_date, l.work_order, l.supplier ?? null, l.is_raw ? 1 : 0, 'MES', 0, null);
    }

    const insOp = db.prepare(`INSERT INTO operations (op_id, work_order, stage, item_code, alloc_mode, equipment, operator, event_time, source_time, source_system, flow_type, scrap_qty, scrap_uom, params_json, quality_flags) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insIn = db.prepare(`INSERT OR REPLACE INTO op_inputs (op_id, lot_no, qty, allocated, uom, role, resolved, raw_lot) VALUES (?,?,?,?,?,?,?,?)`);
    const insOut = db.prepare(`INSERT OR REPLACE INTO op_outputs (op_id, lot_no, qty, uom) VALUES (?,?,?,?)`);
    for (const op of r.operations) {
      insOp.run(op.op_id, op.work_order, op.stage, op.item_code, op.alloc_mode, op.equipment, op.operator,
        op.event_time, op.source_time, op.source_system, op.flow_type, op.scrap_qty, op.scrap_uom,
        JSON.stringify(op.params), JSON.stringify(op.quality_flags));
      for (const i of op.inputs) {
        insIn.run(op.op_id, i.lot, i.qty, i.qty, i.uom, i.role, 1, i.lot);
      }
      for (const o of op.outputs) {
        insOut.run(op.op_id, o.lot, o.qty, o.uom);
      }
    }

    const insEdge = db.prepare(`INSERT OR REPLACE INTO edges (op_id, parent_lot, child_lot, role, qty_consumed, qty_allocated, scrap_share, weight, group_key, event_time, stage, flow_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const e of r.edges) {
      insEdge.run(e.op_id, e.parent_lot, e.child_lot, e.role, e.qty_consumed, e.qty_allocated, e.scrap_share, e.weight, e.group_key, e.event_time, e.stage, e.flow_type);
    }

    const insSerial = db.prepare(`INSERT OR REPLACE INTO serials (serial_no, lot_no, produced_at, shipment_no, customer_code, status) VALUES (?,?,?,?,?,?)`);
    for (const s of r.serials) {
      insSerial.run(s.serial_no, s.lot_no, s.produced_at, s.shipment_no, s.customer_code, s.status);
    }

    const insShip = db.prepare(`INSERT OR REPLACE INTO shipments (shipment_no, customer_code, customer_name, ship_date, destination, carrier) VALUES (?,?,?,?,?,?)`);
    for (const s of r.shipments) insShip.run(s.shipment_no, s.customer_code, s.customer_name, s.ship_date, s.destination, s.carrier ?? '');

    const insLine = db.prepare(`INSERT INTO shipment_lines (shipment_no, lot_no, qty, serials_json) VALUES (?,?,?,?)`);
    for (const l of r.shipmentLines) insLine.run(l.shipment_no, l.lot_no, l.qty, JSON.stringify(l.serials ?? []));

    const insInsp = db.prepare(`INSERT INTO inspections (inspection_no, batch_code, lot_no, inspection_type, item, measured_value, lower_limit, upper_limit, result, raw_result, inspected_at, raw_time, inspector, corrected) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const q of r.inspections) {
      insInsp.run(q.inspection_no, q.batch_code, q.lot_no || null, q.inspection_type, q.item, q.measured_value,
        q.lower_limit, q.upper_limit, q.result, q.result, q.inspected_at, '', q.inspector, 0);
    }

    const insIssue = db.prepare(`INSERT INTO issues (run_id, stage, severity, system, message, ref) VALUES (?,?,?,?,?,?)`);
    for (const i of r.issues) insIssue.run(runId, i.stage, i.severity, i.system, i.message, i.ref);

    const insMap = db.prepare(`INSERT INTO code_mappings (run_id, system, raw, normalized, confidence) VALUES (?,?,?,?,?)`);
    const deduped = new Map<string, { system: string; raw: string; normalized: string; confidence: string }>();
    for (const m of r.mappings) deduped.set(`${m.system}|${m.raw}|${m.normalized}`, m);
    for (const m of deduped.values()) {
      insMap.run(runId, m.system, m.raw, m.normalized, m.confidence);
    }

    db.prepare(`INSERT INTO ingest_runs (run_id, run_at, duration_ms, counts_json) VALUES (?,?,?,?)`).run(
      runId, new Date().toISOString(), 0, JSON.stringify({ counts: r.counts, files: r.files, time: r.timeStats })
    );
  });
  tx();
}
