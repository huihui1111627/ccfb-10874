import fs from 'node:fs';
import path from 'node:path';
import type {
  GenealogyEdge, IngestIssue, InputRole, Inspection, Lot, MesRecord, OperationRow, QmsRecord,
  Serial, Shipment, ShipmentLine, SourceSystem, StageCode, WmsRecord
} from '../../../shared/types.js';
import { normalizeMaterialCode } from '../../../shared/codes.js';
import { parseMesTime, parseQmsTime, utcToLocalParts } from '../../../shared/time.js';
import { MATERIAL_BY_CODE } from '../../../shared/materials.js';
import { readCsv, readJson } from './parse.js';
import { EXPORT_DIR } from '../db/index.js';
import type { MesFlatRow } from './types.js';

export const KG_PER_PIECE: Partial<Record<string, number>> = { 'AL-ADC12->CAL-BLANK': 2.45 };

const OP_TO_STAGE: Record<string, StageCode> = { OP10: 'CAST', OP20: 'MACH', OP30: 'ASSY', OP40: 'FINAL' };
const LINE_TO_PREFIX: Record<string, string> = { '01': 'C', '02': 'M', '03': 'A', '04': 'F' };

let canonicalizeLot: (lot: string) => string = (x) => x;

export const canonicalLot = (lot: string): string => canonicalizeLot(lot);

export const round = (n: number, digits = 4): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

export interface IngestResult {
  lots: Map<string, Lot>;
  operations: OperationRow[];
  edges: GenealogyEdge[];
  serials: Serial[];
  shipments: Shipment[];
  shipmentLines: ShipmentLine[];
  inspections: Inspection[];
  issues: IngestIssue[];
  mappings: { system: string; raw: string; normalized: string; confidence: 'EXACT' | 'RULE' | 'FUZZY' }[];
  timeStats: { system: string; records: number; assumed_tz: string; fixed_formats: string[] }[];
  counts: Record<string, number>;
  files: { name: string; size: number; modified: string }[];
}

interface ParsedMes {
  ops: OperationRow[];
  rowCount: number;
  duplicates: number;
  serials: Map<string, string[]>;
}

export function parseMes(rows: Record<string, string>[], issues: IngestIssue[], mappings: IngestResult['mappings'] = []): ParsedMes {
  const flat: MesFlatRow[] = rows.map((r) => ({
    mes_id: r.mes_id, work_order: r.work_order, op_code: r.op_code, item_code: r.item_code,
    lot_no: r.lot_no, qty: r.qty, scrap_qty: r.scrap_qty, io_type: r.io_type, io_lot: r.io_lot,
    io_item: r.io_item, io_qty: r.io_qty, io_uom: r.io_uom, equipment: r.equipment,
    operator: r.operator, collect_time: r.collect_time, process_params: r.process_params
  }));

  // 1) 行级去重（同 mes_id + 同 IO 行重复导出）
  const seen = new Set<string>();
  const unique: MesFlatRow[] = [];
  let duplicates = 0;
  for (const r of flat) {
    const key = [r.mes_id, r.io_type, r.io_lot, r.io_item, r.io_qty, r.collect_time].join('|');
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    unique.push(r);
  }
  if (duplicates > 0) {
    issues.push({ stage: 'DEDUPE', severity: 'WARN', system: 'MES', message: `MES 导出存在重复行，已剔除 ${duplicates} 行`, ref: 'mes_operations.csv' });
  }

  const grouped = new Map<string, MesFlatRow[]>();
  for (const r of unique) {
    const arr = grouped.get(r.mes_id) ?? [];
    arr.push(r);
    grouped.set(r.mes_id, arr);
  }

  // 批次号归一：MES 内部批次（YYYYMMDD+流水）统一加“工序前缀”形成工厂批次号。
  // 原料采购批（H-/SK-/PT-）不加前缀。先扫一遍产出建立映射，再改写投入引用。
  const lotAlias = new Map<string, string>();
  for (const rs of grouped.values()) {
    const head = rs[0];
    const stage = OP_TO_STAGE[head.op_code];
    if (!stage) continue;
    const prefix = { CAST: 'C', MACH: 'M', ASSY: 'A', FINAL: 'F' }[stage];
    for (const r of rs) {
      if (r.io_type !== 'OUT') continue;
      const mesLot = normalizeLot(r.io_lot);
      if (/^\d{8}\d{3}$/.test(mesLot)) lotAlias.set(mesLot, prefix + mesLot);
    }
  }
  const canonical = (lot: string): string => lotAlias.get(lot) ?? lot;
  canonicalizeLot = canonical;

  const ops: OperationRow[] = [];
  for (const [mesId, rs] of grouped) {
    const head = rs[0];
    const stage = OP_TO_STAGE[head.op_code];
    if (!stage) {
      issues.push({ stage: 'MAPPING', severity: 'ERROR', system: 'MES', message: `未知工序代码 ${head.op_code}`, ref: mesId });
      continue;
    }
    let params: Record<string, string | number> = {};
    try {
      params = JSON.parse(head.process_params) as Record<string, string | number>;
    } catch {
      issues.push({ stage: 'PARSE', severity: 'WARN', system: 'MES', message: '工艺参数 JSON 解析失败', ref: mesId });
      params = { _raw: head.process_params };
    }
    let eventTime: string;
    if (/^\d{4}[/-]\d{2}[/-]\d{2}/.test(head.collect_time)) {
      if (head.collect_time.includes('/')) {
        issues.push({ stage: 'TIME', severity: 'INFO', system: 'MES', message: `时间格式为斜杠日期，已归一化：${head.collect_time}`, ref: mesId });
      }
      eventTime = parseMesTime(head.collect_time);
    } else {
      issues.push({ stage: 'TIME', severity: 'ERROR', system: 'MES', message: `无法识别的时间格式 ${head.collect_time}`, ref: mesId });
      eventTime = '1970-01-01T00:00:00.000Z';
    }
    const inputs = rs.filter((r) => r.io_type === 'IN').map((r) => {
      const mat = normalizeMaterialCode('MES', r.io_item);
      if (mat) mappings.push({ system: 'MES', raw: r.io_item, normalized: mat, confidence: 'EXACT' });
      return {
        lot: canonical(normalizeLot(r.io_lot)), qty: Number(r.io_qty), uom: r.io_uom,
        role: inferRole(stage, r.io_item), material: mat
      };
    });
    const outputs = rs.filter((r) => r.io_type === 'OUT').map((r) => {
      const mat = normalizeMaterialCode('MES', r.io_item);
      if (mat) mappings.push({ system: 'MES', raw: r.io_item, normalized: mat, confidence: 'EXACT' });
      return { lot: canonical(normalizeLot(r.io_lot)), qty: Number(r.io_qty), uom: r.io_uom, material: mat };
    });
    const declared = Number(head.qty || 0);
    const sumOut = round(outputs.reduce((s, o) => s + o.qty, 0), 4);
    const flags: string[] = [];
    if (Math.abs(sumOut - declared) > 0.01) {
      flags.push('QTY_SUM_MISMATCH');
      issues.push({
        stage: 'QTY', severity: 'WARN', system: 'MES',
        message: `主产出数量 ${declared} 与产出明细合计 ${sumOut} 不一致，以明细为准`,
        ref: mesId
      });
    }
    // 合并同批同角色重复投入
    const merged = new Map<string, typeof inputs[number]>();
    for (const i of inputs) {
      const key = i.lot;
      const prev = merged.get(key);
      if (prev) {
        prev.qty = round(prev.qty + i.qty);
        issues.push({ stage: 'DEDUPE', severity: 'INFO', system: 'MES', message: `投入批次 ${i.lot} 在工序内重复出现，已合并`, ref: mesId });
      } else {
        merged.set(key, { ...i });
      }
    }
    ops.push({
      op_id: mesId, work_order: head.work_order, stage,
      item_code: normalizeMaterialCode('MES', head.item_code) ?? head.item_code,
      alloc_mode: stage === 'ASSY' ? 'ASSEMBLY' : 'BLEND',
      equipment: head.equipment, operator: head.operator, event_time: eventTime,
      source_time: head.collect_time, source_system: 'MES' as SourceSystem,
      flow_type: 'NORMAL', scrap_qty: Number(head.scrap_qty || 0),
      scrap_uom: stage === 'CAST' ? 'kg' : '件', params, quality_flags: flags,
      inputs: [...merged.values()] as OperationRow['inputs'],
      outputs: outputs as OperationRow['outputs']
    });
  }
  ops.sort((a, b) => a.event_time.localeCompare(b.event_time));
  // 推断流转类型
  for (const op of ops) {
    if (op.quality_flags.includes('REWORK')) continue;
    op.flow_type = op.outputs.length > 1 ? 'SPLIT' : op.inputs.length > 1 ? 'MERGE' : 'NORMAL';
  }
  return {
    ops,
    rowCount: rows.length,
    duplicates,
    serials: new Map()
  };
}

function normalizeLot(raw: string): string {
  return raw.trim().toUpperCase();
}

function inferRole(stage: StageCode, itemCode: string): InputRole {
  if (stage === 'ASSY') {
    const m = normalizeMaterialCode('MES', itemCode);
    return m === 'SEAL-KIT' || m === 'PISTON' ? 'ADDITIVE' : 'MAIN';
  }
  return stage === 'CAST' ? 'BLEND' : 'MAIN';
}

// =============== WMS ===============

export interface WmsParsed {
  receipts: { lotRef: string; prodLot: string; material: string; qty: number; date: string; supplier: string; location: string; method: 'prod_lot' | 'lot_ref' }[];
  transfers: Map<string, string>; // prodLot -> lotRef
  orphanTransfers: { lotRef: string; material: string; qty: number; date: string }[];
  shipRefs: { lotRef: string; qty: number; shipmentNo: string }[];
  unmatched: number;
}

export function parseWms(rows: Record<string, string>[], issues: IngestIssue[], mappings: IngestResult['mappings']): WmsParsed {
  const receipts: WmsParsed['receipts'] = [];
  const transfers = new Map<string, string>();
  const orphanTransfers: WmsParsed['orphanTransfers'] = [];
  const shipRefs: WmsParsed['shipRefs'] = [];
  const refToLot = new Map<string, string>();
  // 先收 prod_lot 的入库/收货，建立 lot_ref -> prod_lot
  for (const r of rows) {
    const prod = r.prod_lot ? normalizeLot(r.prod_lot) : null;
    if (prod && r.lot_ref) refToLot.set(normalizeLot(r.lot_ref), prod);
  }
  let unresolvedMaterial = 0;
  for (const r of rows) {
    const material = normalizeMaterialCode('WMS', r.material_no);
    if (!material) {
      unresolvedMaterial++;
      issues.push({ stage: 'MAPPING', severity: 'WARN', system: 'WMS', message: `物料编码 ${r.material_no} 无法映射，按批次前缀推断`, ref: r.wms_no });
    }
    const prod = r.prod_lot ? normalizeLot(r.prod_lot) : refToLot.get(normalizeLot(r.lot_ref)) ?? null;
    if (material) {
      mappings.push({ system: 'WMS', raw: r.material_no, normalized: material, confidence: material === 'CAL-FIN' && r.material_no !== '10001007' ? 'FUZZY' : 'EXACT' });
    }
    const date = utcToLocalParts(r.event_time_utc).date;
    if (r.move_type === 'RECEIPT') {
      const inferred = material ?? (prod ? inferMaterialFromLot(prod) : null);
      if (!prod) {
        // 缺 prod_lot：登记为占位收货，稍后按 物料+数量+日期 反查
        receipts.push({
          lotRef: r.lot_ref, prodLot: `?${r.lot_ref}`, material: inferred ?? 'UNKNOWN', qty: Number(r.qty),
          date, supplier: r.supplier, location: r.location, method: 'lot_ref'
        });
        continue;
      }
      if (!inferred) {
        issues.push({ stage: 'MAPPING', severity: 'ERROR', system: 'WMS', message: `无法确定 ${prod} 的物料`, ref: r.wms_no });
        continue;
      }
      if (r.material_no === '10001070') {
        issues.push({ stage: 'MAPPING', severity: 'INFO', system: 'WMS', message: `物料 ${r.material_no} 疑似 10001007 录入错位，按批次 ${prod} 纠正为 ${inferred}`, ref: r.wms_no });
      }
      receipts.push({
        lotRef: r.lot_ref, prodLot: prod, material: inferred, qty: Number(r.qty), date,
        supplier: r.supplier, location: r.location, method: r.prod_lot ? 'prod_lot' : 'lot_ref'
      });
      refToLot.set(normalizeLot(r.lot_ref), prod);
    } else if (r.move_type === 'TRANSFER' && prod) {
      transfers.set(prod, r.lot_ref);
    } else if (r.move_type === 'TRANSFER' && !prod) {
      orphanTransfers.push({ lotRef: r.lot_ref, material: material ?? 'CAL-FIN', qty: Number(r.qty), date });
    } else if (r.move_type === 'SHIP') {
      shipRefs.push({ lotRef: r.lot_ref, qty: Number(r.qty), shipmentNo: r.shipment_no });
    }
  }
  return { receipts, transfers, orphanTransfers, shipRefs, unmatched: unresolvedMaterial };
}

function inferMaterialFromLot(lot: string): string | null {
  if (/^H-\d{4}-\d{3}$/.test(lot)) return 'AL-ADC12';
  if (/^SK-/i.test(lot)) return 'SEAL-KIT';
  if (/^PT-/i.test(lot)) return 'PISTON';
  const p = lot[0];
  return { C: 'CAL-BLANK', M: 'CAL-BODY', A: 'CAL-ASSY', F: 'CAL-FIN' }[p] ?? null;
}

// =============== QMS ===============

export function qmsBatchToLot(batchCode: string): string | null {
  const iq = batchCode.match(/^IQ-([A-Z]{2})(\d{4})(\d{3})$/);
  if (iq) return `${iq[1]}-${iq[2]}-${iq[3]}`;
  const iqH = batchCode.match(/^IQ-H(\d{4})(\d{3})$/);
  if (iqH) return `H-${iqH[1]}-${iqH[2]}`;
  const m = batchCode.match(/^Q-(\d{8})-(\d{2})-(\d{3})$/);
  if (!m) return null;
  const prefix = LINE_TO_PREFIX[m[2]];
  if (!prefix) return null;
  return `${prefix}${m[1]}${m[3]}`;
}

export function parseQms(rows: Record<string, string>[], issues: IngestIssue[], mappings: IngestResult['mappings']): Inspection[] {
  const out: Inspection[] = [];
  let timeFixed = 0;
  for (const r of rows) {
    const lot = qmsBatchToLot(r.batch_code);
    if (!lot) {
      issues.push({ stage: 'UNMATCHED', severity: 'WARN', system: 'QMS', message: `检验批次编码 ${r.batch_code} 不符合任何规则`, ref: r.inspection_no });
    }
    const product = normalizeMaterialCode('QMS', r.product_code);
    if (product) mappings.push({ system: 'QMS', raw: r.product_code, normalized: product, confidence: 'RULE' });
    let at: string;
    try {
      at = parseQmsTime(r.inspected_at);
      if (/^\d{2}\/\d{2}\/\d{4}/.test(r.inspected_at)) timeFixed++;
    } catch {
      issues.push({ stage: 'TIME', severity: 'ERROR', system: 'QMS', message: `时间格式异常 ${r.inspected_at}`, ref: r.inspection_no });
      at = '1970-01-01T00:00:00.000Z';
    }
    const measured = Number(r.measured_value);
    const upper = Number(r.upper_limit);
    const lower = Number(r.lower_limit);
    const derivedFail = measured > upper || measured < lower;
    const reported: 'PASS' | 'FAIL' = r.result === 'FAIL' ? 'FAIL' : 'PASS';
    let result: 'PASS' | 'FAIL' = reported;
    if (derivedFail && reported === 'PASS') {
      result = 'FAIL';
      issues.push({
        stage: 'QTY', severity: 'ERROR', system: 'QMS',
        message: `结果矛盾：实测 ${measured} 超出规格 [${lower}, ${upper}]，原判 PASS，已按实测改判 FAIL（${r.item}）`,
        ref: r.inspection_no
      });
    } else if (!derivedFail && reported === 'FAIL') {
      issues.push({
        stage: 'QTY', severity: 'WARN', system: 'QMS',
        message: `结果矛盾：实测 ${measured} 在规格内，原判 FAIL，保留原判定交由质量复核`,
        ref: r.inspection_no
      });
    }
    out.push({
      id: 0, inspection_no: r.inspection_no, batch_code: r.batch_code, lot_no: lot ?? '',
      inspection_type: r.inspection_type, item: r.item, measured_value: measured,
      lower_limit: lower, upper_limit: upper, result, inspected_at: at, inspector: r.inspector
    });
  }
  return out;
}

// =============== 批次构建与对齐 ===============

const RAW_LOT_PATTERNS: { re: RegExp; material: string }[] = [
  { re: /^H-\d{4}-\d{3}$/, material: 'AL-ADC12' },
  { re: /^SK-\d{4}-\d{3}$/, material: 'SEAL-KIT' },
  { re: /^PT-\d{4}-\d{3}$/, material: 'PISTON' }
];

function rawMaterialOf(lot: string): string | null {
  for (const p of RAW_LOT_PATTERNS) if (p.re.test(lot)) return p.material;
  return null;
}

function dateOfLot(lot: string): string {
  const raw = lot.replace(/^[CMAF]/, '');
  if (/^\d{8}/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return '';
}

/**
 * 建立批次全集并解析 MES 投入引用。
 * 顺序：MES 产出 -> 有 prod_lot 的收货 -> MES 投入引用解析（纠错） -> 缺 prod_lot 的收货反查
 */
export function buildLotUniverse(ops: OperationRow[], receipts: WmsParsed['receipts'], issues: IngestIssue[], canonical: (lot: string) => string = (x) => x): Map<string, Lot> {
  const lots = new Map<string, Lot>();
  const receiptByLot = new Set<string>();

  for (const op of ops) {
    for (const o of op.outputs) {
      const material = o.material ?? inferMaterialFromLot(o.lot);
      const mat = material ? MATERIAL_BY_CODE.get(material) : undefined;
      if (!mat) {
        issues.push({ stage: 'MAPPING', severity: 'ERROR', system: 'MES', message: `产出批次 ${o.lot} 的物料无法确定`, ref: op.op_id });
        continue;
      }
      const existing = lots.get(o.lot);
      if (existing) {
        existing.qty_produced = round(existing.qty_produced + o.qty);
        continue;
      }
      lots.set(o.lot, {
        id: o.lot, lot_no: o.lot, material_code: mat.code, material_name: mat.name, stage: mat.stage,
        uom: mat.uom, qty_produced: o.qty, qty_remaining: 0,
        production_date: utcToLocalParts(op.event_time).date || dateOfLot(o.lot),
        work_order: op.work_order, is_raw: false, suspect: 0, suspect_reason: null
      });
    }
  }

  for (const r of receipts) {
    if (r.prodLot.startsWith('?')) continue;
    const mat = MATERIAL_BY_CODE.get(r.material);
    if (!mat) continue;
    const existing = lots.get(r.prodLot);
    if (existing) {
      existing.supplier = r.supplier;
      if (!existing.work_order) existing.qty_produced = round(existing.qty_produced + r.qty);
      receiptByLot.add(r.prodLot);
      continue;
    }
    lots.set(r.prodLot, {
      id: r.prodLot, lot_no: r.prodLot, material_code: mat.code, material_name: mat.name,
      stage: mat.stage, uom: mat.uom, qty_produced: r.qty, qty_remaining: 0,
      production_date: r.date || dateOfLot(r.prodLot), work_order: '', supplier: r.supplier,
      is_raw: mat.is_raw, suspect: 0, suspect_reason: null
    });
    receiptByLot.add(r.prodLot);
  }

  // 解析 MES 投入引用；纠错结果直接写回 op.inputs
  for (const op of ops) {
    for (const i of op.inputs) {
      if (lots.has(i.lot)) continue;
      // 原料采购批（H-/SK-/PT-）按定义就是合法批号，不做纠错，直接登记为原料批；
      // 其收货记录可能缺失（WMS 缺 prod_lot），后续按数量+日期反查回填。
      const rawMaterial = rawMaterialOf(i.lot);
      if (rawMaterial) {
        const mat = MATERIAL_BY_CODE.get(rawMaterial)!;
        const existing = lots.get(i.lot);
        if (existing) {
          existing.qty_produced = round(existing.qty_produced + i.qty);
          continue;
        }
        lots.set(i.lot, {
          id: i.lot, lot_no: i.lot, material_code: mat.code, material_name: mat.name, stage: mat.stage,
          uom: mat.uom, qty_produced: i.qty, qty_remaining: 0,
          production_date: dateOfLot(i.lot) || utcToLocalParts(op.event_time).date,
          work_order: '', is_raw: true, suspect: 0, suspect_reason: null
        });
        continue;
      }
      const res = resolveLotRef(i.lot, lots, canonical);
      if (res) {
        if (res.lot !== i.lot) {
          issues.push({
            stage: 'MAPPING', severity: 'WARN', system: 'MES',
            message: `投入批次「${i.lot}」在批次库中不存在，按${res.how}纠正为「${res.lot}」`,
            ref: op.op_id
          });
          op.quality_flags.push('LOT_CORRECTED');
          i.lot = res.lot;
        }
        continue;
      }
      issues.push({ stage: 'UNMATCHED', severity: 'ERROR', system: 'MES', message: `投入批次 ${i.lot} 无法解析（无相似批次）`, ref: op.op_id });
    }
    if (op.inputs.length === 0) {
      issues.push({ stage: 'PARSE', severity: 'ERROR', system: 'MES', message: `工序无投入记录（可能被截断）`, ref: op.op_id });
    }
  }

  // 缺失 prod_lot 的收货：按 物料 + 数量 + 日期邻近 反查唯一批次
  const orphanReceipts = receipts.filter((r) => r.method === 'lot_ref');
  for (const r of orphanReceipts) {
    if (receiptByLot.has(r.prodLot)) continue;
    void r;
  }
  return lots;
}

/** 投入批次引用纠错：形近字符、相邻转置、尾部多余字符、唯一编辑距离 1 */
export function resolveLotRef(raw: string, lots: Map<string, Lot>, canonical: (lot: string) => string = (x) => x): { lot: string; how: string } | null {
  const upper = raw.trim().toUpperCase();
  const candidates: { lot: string; how: string }[] = [];
  const check = (variant: string, how: string) => {
    const c = canonical(variant);
    if (lots.has(c)) candidates.push({ lot: c, how });

  };
  const stripped = upper.replace(/[A-Z]$/, '');
  check(stripped, '去除尾部多余字符');
  const chars = upper.replace(/O/g, '0').replace(/I/g, '1').replace(/S/g, '5').replace(/L/g, '1');
  check(chars, '形近字符纠正');
  for (let i = 0; i < chars.length - 1; i++) {
    const swapped = chars.slice(0, i) + chars[i + 1] + chars[i] + chars.slice(i + 2);
    check(swapped, '相邻字符转置纠正');
  }
  if (candidates.length) return candidates[0];
  const scored: { lot: string; dist: number }[] = [];
  for (const lot of lots.values()) {
    const cmpA = lot.lot_no.replace(/^[CMAF]/, '');
    const d = editDistance(upper, lot.lot_no) <= 1 ? editDistance(upper, lot.lot_no) : editDistance(upper, cmpA);
    if (d <= 1) scored.push({ lot: lot.lot_no, dist: d });
  }
  if (scored.length === 1) return { lot: scored[0].lot, how: '编辑距离匹配' };
  return null;
}

/**
 * 缺 prod_lot 的 WMS 收货反查：按物料编码 + 数量 + 收货日期附近的生产/收货记录匹配。
 * 返回更正后的收货记录。
 */
export function reconcileOrphanReceipts(
  receipts: WmsParsed['receipts'], lots: Map<string, Lot>, ops: OperationRow[], issues: IngestIssue[]
): WmsParsed['receipts'] {
  const claimed = new Set(receipts.filter((r) => !r.prodLot.startsWith('?')).map((r) => r.prodLot));
  const out: WmsParsed['receipts'] = [];
  for (const r of receipts) {
    if (!r.prodLot.startsWith('?')) {
      out.push(r);
      continue;
    }
    const tolerance = Math.max(1, r.qty * 0.02);
    // 原料批的产出量 = MES 各工序投入之和（炉料分批投用），不是单次投入量；
    // 若该原料批尚无任何收货记录，其数量只能由投诉/投料侧反推，不能作为筛选条件。
    const consumedTotals = new Map<string, number>();
    for (const op of ops) {
      for (const i of op.inputs) consumedTotals.set(i.lot, round((consumedTotals.get(i.lot) ?? 0) + i.qty, 4));
    }
    // 原料批的“生产日期”在 MES 侧只能取首次投料日，与收货日可能相差数周，
    // 因此原料批放宽到 ±14 天，包装件/成品仍用 ±2 天。
    const dateMatched = [...lots.values()].filter((l) => {
      if (l.material_code !== r.material) return false;
      if (claimed.has(l.lot_no)) return false;
      const window = l.is_raw ? 21 : 2;
      if (r.date && l.production_date && Math.abs(dayDiff(l.production_date, r.date)) > window) return false;
      return true;
    });
    // 优先用数量精确吻合的批次（已有收货量或产出量），否则再看是否只剩唯一候选
    const qtyMatched = dateMatched.filter((l) => {
      const produced = l.is_raw ? Math.max(l.qty_produced, consumedTotals.get(l.lot_no) ?? 0) : l.qty_produced;
      return Math.abs(produced - r.qty) <= tolerance;
    });
    const candidates = qtyMatched.length ? qtyMatched : dateMatched.filter((l) => l.is_raw);
    // 同物料+数量可能撞车；用日期最近、且未被认领来消歧
    candidates.sort((a, b) => Math.abs(dayDiff(a.production_date, r.date)) - Math.abs(dayDiff(b.production_date, r.date)));
    const unique = candidates.filter((c, idx, arr) => arr.findIndex((x) => x.lot_no === c.lot_no) === idx);
    if (unique.length === 1) {
      const c = unique[0];
      issues.push({
        stage: 'MAPPING', severity: 'WARN', system: 'WMS',
        message: `收货 ${r.lotRef} 缺 prod_lot，按 物料(${r.material})+数量(${r.qty})+日期(${r.date}) 唯一反查为 ${c.lot_no}`,
        ref: r.lotRef
      });
      c.supplier = r.supplier || c.supplier;
      c.qty_produced = r.qty;
      claimed.add(c.lot_no);
      out.push({ ...r, prodLot: c.lot_no });
      continue;
    }
    issues.push({
      stage: 'UNMATCHED', severity: 'ERROR', system: 'WMS',
      message: `收货 ${r.lotRef} 缺 prod_lot，候选批次 ${unique.length} 个${unique.length ? `（${unique.map((c) => c.lot_no).slice(0, 4).join(', ')}）` : ''}，暂保留为未知批，需人工确认供应商归属`,
      ref: r.lotRef
    });
    out.push(r);
  }
  return out;
}

/** 入库记录缺 prod_lot：按 物料 + 入库数量 == 批次产出量 + 日期邻近 反查成品批 */
export function reconcileOrphanTransfers(
  orphan: WmsParsed['orphanTransfers'], lots: Map<string, Lot>, transfers: Map<string, string>, issues: IngestIssue[]
): void {
  const usedLots = new Set(transfers.keys());
  for (const t of orphan) {
    const candidates = [...lots.values()].filter((l) =>
      l.material_code === t.material && !usedLots.has(l.lot_no) &&
      Math.abs(l.qty_produced - t.qty) < 0.5 &&
      Math.abs(dayDiff(l.production_date, t.date)) <= 2
    );
    if (candidates.length === 1) {
      transfers.set(candidates[0].lot_no, t.lotRef);
      usedLots.add(candidates[0].lot_no);
      issues.push({
        stage: 'MAPPING', severity: 'WARN', system: 'WMS',
        message: `入库 ${t.lotRef} 缺 prod_lot，按 物料+数量(${t.qty})+日期(${t.date}) 唯一反查为 ${candidates[0].lot_no}`,
        ref: t.lotRef
      });
    } else {
      issues.push({
        stage: 'UNMATCHED', severity: 'WARN', system: 'WMS',
        message: `入库 ${t.lotRef} 缺 prod_lot，候选 ${candidates.length} 个，发货明细将按数量+日期兜底匹配`,
        ref: t.lotRef
      });
    }
  }
}

function dayDiff(a: string, b: string): number {
  if (!a || !b) return 999;
  return Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
}

// =============== 谱系边 ===============

export function buildEdges(ops: OperationRow[], lots: Map<string, Lot>, issues: IngestIssue[]): GenealogyEdge[] {
  const edges: GenealogyEdge[] = [];
  for (const op of ops) {
    const valid = op.inputs.filter((i) => lots.has(i.lot));
    if (!valid.length || !op.outputs.length) continue;
    if (valid.length !== op.inputs.length) {
      // 有未解析投入：不做半截谱系，但记录以便人工补录
      issues.push({ stage: 'UNMATCHED', severity: 'ERROR', system: 'MES', message: `工序有 ${op.inputs.length - valid.length} 条投入未解析，暂不生成谱系边`, ref: op.op_id });
      continue;
    }

    const totalIn = valid.reduce((s, i) => s + i.qty, 0);
    const totalOut = op.outputs.reduce((s, o) => s + o.qty, 0);
    if (totalIn <= 0 || totalOut <= 0) continue;

    // 装配按物料组归一：本体 / 密封件 / 活塞 各自独立计量
    const groupOf = (mat: string | null | undefined) => (op.alloc_mode === 'ASSEMBLY' ? (mat ?? 'UNKNOWN') : 'ALL');
    const groupTotals = new Map<string, number>();
    for (const i of valid) {
      const g = groupOf(i.material);
      groupTotals.set(g, (groupTotals.get(g) ?? 0) + i.qty);
    }
    const scrapRatio = Math.min(1, op.scrap_qty / Math.max(totalIn, 1e-9));
    for (const i of valid) {
      const g = groupOf(i.material);
      const gTotal = groupTotals.get(g) ?? totalIn;
      const localShare = i.qty / gTotal;
      for (const o of op.outputs) {
        const outShare = o.qty / totalOut;
        edges.push({
          id: 0, op_id: op.op_id, parent_lot: i.lot, child_lot: o.lot,
          qty_consumed: round(i.qty, 4),
          qty_allocated: round(i.qty * (1 - scrapRatio), 4),
          scrap_share: round(i.qty * scrapRatio * outShare, 4),
          role: i.role, weight: round(localShare * outShare, 8),
          work_order: op.work_order, stage: op.stage, equipment: op.equipment, operator: op.operator,
          event_time: op.event_time, source_time: op.source_time, source_system: op.source_system,
          params: op.params, flow_type: op.flow_type,
          quality_flags: [...op.quality_flags],
          group_key: `${op.op_id}:${g}`
        });
      }
    }
  }
  return edges;
}

export function fuzzyLotMatch(raw: string, lots: Map<string, Lot>): string | null {
  const upper = raw.trim().toUpperCase();
  if (lots.has(upper)) return upper;
  const stripped = upper.replace(/[A-Z]$/, '');
  if (lots.has(stripped)) return stripped;
  const chars = upper.replace(/O/g, '0').replace(/I/g, '1').replace(/S/g, '5').replace(/L/g, '1');
  if (lots.has(chars)) return chars;
  for (let i = 0; i < chars.length - 1; i++) {
    const swapped = chars.slice(0, i) + chars[i + 1] + chars[i] + chars.slice(i + 2);
    if (lots.has(swapped)) return swapped;
  }
  let best: { lot: string; dist: number } | null = null;
  for (const lot of lots.values()) {
    if (Math.abs(lot.lot_no.length - upper.length) > 1) continue;
    const d = editDistance(upper, lot.lot_no);
    if (d <= 1 && (!best || d < best.dist)) best = { lot: lot.lot_no, dist: d };
  }
  return best?.lot ?? null;
}

function editDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

// =============== 发货对齐 ===============

export interface ShipRaw {
  shipment_no: string; customer_code: string; customer_name: string; ship_date: string;
  destination: string; carrier: string; lines: { lot_ref: string; qty: number; serials: string[] }[];
}

export function alignShipments(
  shipmentsRaw: ShipRaw[],
  transfers: Map<string, string>,
  shipRefs: { lotRef: string; qty: number; shipmentNo: string }[],
  lots: Map<string, Lot>,
  issues: IngestIssue[]
): { shipments: Shipment[]; lines: ShipmentLine[]; serialOverrides: Map<string, string> } {
  const shipments: Shipment[] = [];
  const lines: ShipmentLine[] = [];
  const refToLot = new Map<string, string>();
  for (const [lot, ref] of transfers) refToLot.set(ref, lot);
  for (const s of shipRefs) {
    // SHIP 记录的 prod_lot 在源系统中为空，只能靠 lot_ref 反查
    const lot = refToLot.get(s.lotRef);
    if (lot) refToLot.set(s.lotRef, lot);
  }
  const serialOverrides = new Map<string, string>();
  for (const sh of shipmentsRaw) {
    const claimedInShipment = new Set<string>();
    shipments.push({
      shipment_no: sh.shipment_no, customer_code: sh.customer_code, customer_name: sh.customer_name,
      ship_date: sh.ship_date, destination: sh.destination, carrier: sh.carrier, lines: []
    });
    for (const line of sh.lines) {
      let lot = refToLot.get(line.lot_ref) ?? null;
      let method = 'LOT_REF';
      if (!lot) {
        // 库位标签缺失（WMS 缺 prod_lot 的几笔），用“数量+发货日期+物料”匹配唯一成品批
        lot = matchByQtyAndDate(line.qty, sh.ship_date, lots, claimedInShipment);
        method = lot ? 'QTY_DATE' : 'NONE';
      }
      if (!lot) {
        issues.push({ stage: 'UNMATCHED', severity: 'ERROR', system: 'WMS', message: `发货单 ${sh.shipment_no} 明细 ${line.lot_ref} 无法对齐到成品批次`, ref: line.lot_ref });
        continue;
      }
      if (method === 'QTY_DATE') {
        issues.push({ stage: 'MAPPING', severity: 'WARN', system: 'WMS', message: `发货明细 ${line.lot_ref} 通过数量+日期匹配到批次 ${lot}`, ref: sh.shipment_no });
      }
      claimedInShipment.add(lot);
      const shipment: Shipment = shipments[shipments.length - 1];
      shipment.lines.push({ shipment_no: sh.shipment_no, lot_no: lot, qty: line.qty, serials: line.serials });
      lines.push({ shipment_no: sh.shipment_no, lot_no: lot, qty: line.qty, serials: line.serials });
      for (const sn of line.serials) serialOverrides.set(sn, sh.shipment_no);
    }
  }
  return { shipments, lines, serialOverrides };
}

function matchByQtyAndDate(qty: number, shipDate: string, lots: Map<string, Lot>, exclude: Set<string>): string | null {
  let best: { lot: string; score: number } | null = null;
  for (const l of lots.values()) {
    if (l.stage !== 'FINAL' || exclude.has(l.lot_no)) continue;
    if (l.qty_produced < qty - 1) continue;
    if (l.production_date > shipDate) continue;
    const diff = Math.abs(l.qty_produced - qty);
    if (!best || diff < best.score) best = { lot: l.lot_no, score: diff };
  }
  return best && best.score < Math.max(30, qty * 0.35) ? best.lot : null;
}

function findLotForSerial(outputs: OperationRow['outputs'], index: number): string | null {
  let cursor = 0;
  for (const o of outputs) {
    const n = Math.floor(o.qty);
    if (index < cursor + n) return o.lot;
    cursor += n;
  }
  return outputs[outputs.length - 1]?.lot ?? null;
}

// =============== 主流程 ===============

export function runIngest(): { result: IngestResult; runId: string } {
  const issues: IngestIssue[] = [];
  const mappings: IngestResult['mappings'] = [];
  const files = fs.readdirSync(EXPORT_DIR).map((name) => {
    const st = fs.statSync(path.join(EXPORT_DIR, name));
    return { name, size: st.size, modified: st.mtime.toISOString() };
  });

  const mesRows = readCsv(path.join(EXPORT_DIR, 'mes_operations.csv'));
  const wmsRows = readCsv(path.join(EXPORT_DIR, 'wms_moves.csv')) as unknown as Record<string, string>[];
  const qmsRows = readCsv(path.join(EXPORT_DIR, 'qms_inspections.csv'));
  const shipRaw = readJson<ShipRaw[]>(path.join(EXPORT_DIR, 'shipments.json'));
  const serialRaw = readJson<{ mes_id: string; lot_no: string; serials: string[] }[]>(path.join(EXPORT_DIR, 'mes_serials.json'));

  const parsedMes = parseMes(mesRows, issues, mappings);
  const serialsByMes = new Map<string, string[]>();
  for (const s of serialRaw) serialsByMes.set(s.mes_id, s.serials);

  const wms = parseWms(wmsRows, issues, mappings);
  const lots = buildLotUniverse(parsedMes.ops, wms.receipts, issues, canonicalLot);
  const reconciled = reconcileOrphanReceipts(wms.receipts, lots, parsedMes.ops, issues);
  reconcileOrphanTransfers(wms.orphanTransfers, lots, wms.transfers, issues);

  // 用 MES 序列号文件给成品批次挂序列号
  for (const op of parsedMes.ops) {
    if (op.stage !== 'FINAL') continue;
    const sns = serialsByMes.get(op.op_id) ?? [];
    for (const o of op.outputs) {
      const lot = lots.get(o.lot);
      if (lot) lot.serials = sns.slice(0, Math.floor(o.qty));
    }
  }

  const edges = buildEdges(parsedMes.ops, lots, issues);
  const inspections = parseQms(qmsRows, issues, mappings);
  const aligned = alignShipments(shipRaw, wms.transfers, wms.shipRefs, lots, issues);

  // 序列号表
  const serials: Serial[] = [];
  for (const op of parsedMes.ops) {
    if (op.stage !== 'FINAL') continue;
    const sns = serialsByMes.get(op.op_id) ?? [];
    for (const sn of sns) {
      const lotNo = findLotForSerial(op.outputs, sns.indexOf(sn));
      const shipNo = aligned.serialOverrides.get(sn) ?? null;
      const ship = aligned.shipments.find((s) => s.shipment_no === shipNo);
      serials.push({
        serial_no: sn, lot_no: lotNo ?? op.outputs[0].lot,
        produced_at: op.event_time, shipment_no: shipNo,
        customer_code: ship?.customer_code ?? null,
        status: shipNo ? 'SHIPPED' : 'IN_STOCK', rework_count: 0
      });
    }
  }

  // 剩余数量（原料 + 在制 + 成品）
  const consumed = new Map<string, number>();
  for (const e of edges) {
    // 每个父批-子批只计一次 qty_consumed（按 op 去重）
    const key = `${e.op_id}|${e.parent_lot}`;
    if (!consumed.has(key)) consumed.set(key, 0);
  }
  for (const op of parsedMes.ops) {
    for (const i of op.inputs) {
      const lot = lots.has(i.lot) ? i.lot : fuzzyLotMatch(i.lot, lots);
      if (!lot) continue;
      const key = `${op.op_id}|${lot}`;
      if (consumed.has(key) && (consumed.get(key) ?? 0) > 0) continue;
      consumed.set(key, i.qty);
    }
  }
  const consumedByLot = new Map<string, number>();
  for (const [key, qty] of consumed) {
    const lot = key.split('|')[1];
    consumedByLot.set(lot, round((consumedByLot.get(lot) ?? 0) + qty, 4));
  }
  const shippedByLot = new Map<string, number>();
  for (const line of aligned.lines) {
    shippedByLot.set(line.lot_no, round((shippedByLot.get(line.lot_no) ?? 0) + line.qty, 4));
  }
  for (const lot of lots.values()) {
    let remain = round(lot.qty_produced - (consumedByLot.get(lot.lot_no) ?? 0), 4);
    if (lot.stage === 'FINAL') remain = round(remain - (shippedByLot.get(lot.lot_no) ?? 0), 4);
    lot.qty_remaining = Math.max(0, remain);
  }

  const counts = {
    mes_rows: parsedMes.rowCount,
    mes_ops: parsedMes.ops.length,
    mes_duplicates: parsedMes.duplicates,
    wms_moves: wmsRows.length,
    qms_inspections: qmsRows.length,
    lots: lots.size,
    edges: edges.length,
    serials: serials.length,
    shipments: aligned.shipments.length,
    shipment_lines: aligned.lines.length,
    inspections: inspections.length
  };
  const timeStats = [
    { system: 'MES', records: parsedMes.ops.length, assumed_tz: 'Asia/Shanghai (UTC+8)', fixed_formats: ['YYYY/MM/DD HH:mm:ss -> YYYY-MM-DD HH:mm:ss'] },
    { system: 'WMS', records: wmsRows.length, assumed_tz: 'UTC (ISO 8601)', fixed_formats: [] },
    { system: 'QMS', records: qmsRows.length, assumed_tz: 'Asia/Shanghai (UTC+8), DD/MM/YYYY HH:mm', fixed_formats: ['DD/MM/YYYY HH:mm -> ISO UTC'] }
  ];

  const runId = `ING-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  return {
    result: {
      lots, operations: parsedMes.ops, edges, serials,
      shipments: aligned.shipments, shipmentLines: aligned.lines,
      inspections, issues, mappings, timeStats, counts, files
    },
    runId
  };
}
