import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMonth } from './generate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const dataDir = path.join(root, 'data');
const exportDir = path.join(dataDir, 'exports');
const truthDir = path.join(dataDir, 'truth');

fs.mkdirSync(exportDir, { recursive: true });
fs.mkdirSync(truthDir, { recursive: true });

const { exports, truth } = generateMonth();

function writeCsv(file: string, rows: Record<string, unknown>[], columns: string[]) {
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => esc(r[c])).join(','));
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

// MES：嵌套投入/产出拍平为多行，模拟真实 MES 导出（一次导出多行，表头重复）
const mesCsvLines: string[] = ['mes_id,work_order,op_code,item_code,lot_no,qty,scrap_qty,io_type,io_lot,io_item,io_qty,io_uom,equipment,operator,collect_time,process_params'];
for (const r of exports.mes) {
  for (const i of r.inputs) {
    mesCsvLines.push([r.mes_id, r.work_order, r.op_code, r.item_code, r.lot_no, r.qty, r.scrap_qty, 'IN', i.lot, i.item_code, i.qty, i.uom, r.equipment, r.operator, r.collect_time, r.process_params].map((v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','));
  }
  for (const o of r.outputs) {
    mesCsvLines.push([r.mes_id, r.work_order, r.op_code, r.item_code, r.lot_no, r.qty, r.scrap_qty, 'OUT', o.lot, o.item_code, o.qty, o.uom, r.equipment, r.operator, r.collect_time, r.process_params].map((v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','));
  }
}
fs.writeFileSync(path.join(exportDir, 'mes_operations.csv'), mesCsvLines.join('\n') + '\n', 'utf8');
fs.writeFileSync(path.join(exportDir, 'mes_serials.json'), JSON.stringify(exports.mes.filter((m) => m.serials?.length).map((m) => ({ mes_id: m.mes_id, lot_no: m.lot_no, serials: m.serials })), null, 2));

writeCsv(path.join(exportDir, 'wms_moves.csv'), exports.wms as unknown as Record<string, unknown>[], [
  'wms_no', 'move_type', 'material_no', 'lot_ref', 'prod_lot', 'qty', 'uom', 'location', 'shipment_no', 'event_time_utc', 'supplier'
]);

writeCsv(path.join(exportDir, 'qms_inspections.csv'), exports.qms as unknown as Record<string, unknown>[], [
  'inspection_no', 'batch_code', 'inspection_type', 'product_code', 'item', 'measured_value', 'lower_limit', 'upper_limit', 'result', 'inspected_at', 'inspector'
]);

fs.writeFileSync(path.join(exportDir, 'shipments.json'), JSON.stringify(exports.shipments, null, 2));
fs.writeFileSync(path.join(truthDir, 'truth.json'), JSON.stringify(truth, null, 2));

console.log('模拟数据生成完成');
console.log(JSON.stringify(truth.stats, null, 2));
console.log(`输出目录: ${exportDir}`);
console.log(`真实谱系: ${path.join(truthDir, 'truth.json')}`);
