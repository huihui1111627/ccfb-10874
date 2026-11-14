import { Rng } from './prng.js';
import { MATERIAL_BY_CODE, type MaterialDef } from '../../../shared/materials.js';
import type {
  FlowType, InputRole, Lot, MesRecord, OperationRow, QmsRecord, Serial, ShipmentRecord,
  SourceSystem, StageCode, WmsRecord
} from '../../../shared/types.js';
import { makeSerial } from '../../../shared/codes.js';
import { toUtcIso } from '../../../shared/time.js';

const KG_PER_BLANK = 2.45;
const CAST_YIELD = 0.965;

export const PLANT_START = '2025-09-01';
export const PLANT_END = '2025-09-30';
export const COMPLAINT_HEAT = 'H-2509-014';

export interface Complaint {
  complaint_no: string;
  customer_code: string;
  customer_name: string;
  product: string;
  issue: string;
  reported_at: string;
  heat_lot: string;
  serials: string[];
}

export interface InjectedIssue {
  id: string;
  kind: string;
  target: string;
  description: string;
}

export interface TruthData {
  generated_at: string;
  days: string[];
  lots: Lot[];
  operations: OperationRow[];
  serials: Serial[];
  shipments: ShipmentRecord[];
  inspections: QmsRecord[];
  complaints: Complaint[];
  injected: InjectedIssue[];
  stats: Record<string, number>;
}

export interface Exports {
  mes: MesRecord[];
  wms: WmsRecord[];
  qms: QmsRecord[];
  shipments: ShipmentRecord[];
  materials: unknown[];
}

interface LotState {
  lot_no: string;
  mes_lot: string;
  material: MaterialDef;
  qty_produced: number;
  qty_remaining: number;
  production_date: string;
  work_order: string;
  supplier: string | null;
  serials: string[];
  rework_of: string | null;
  stock_ref: string | null;
}

interface InternalOp extends OperationRow {
  mes_id: string;
}

const CUSTOMERS = [
  { code: 'CH-A', name: '上海汽车制动系统有限公司', region: '华东', destination: '上海安亭', weight: 4 },
  { code: 'CH-B', name: '广州底盘科技有限公司', region: '华南', destination: '广州花都', weight: 3 },
  { code: 'CH-C', name: '成都车桥股份有限公司', region: '西南', destination: '成都经开区', weight: 2 },
  { code: 'CH-D', name: '华北汽配售后市场', region: '华北', destination: '天津武清', weight: 2 },
  { code: 'CH-E', name: 'NorthStar Auto Parts', region: '北美', destination: 'Long Beach, CA', weight: 1 }
];

const RAW_SUPPLIERS = ['华铝金属材料有限公司', '南山铝业股份', '立中合金集团'];

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function workingDays(): string[] {
  const out: string[] = [];
  const d = new Date(`${PLANT_START}T00:00:00Z`);
  const end = new Date(`${PLANT_END}T00:00:00Z`);
  while (d <= end) {
    if (d.getUTCDay() !== 0) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function generateMonth(seed = 20250901): { exports: Exports; truth: TruthData } {
  const rng = new Rng(seed);
  // 质量抽检使用独立随机流，避免与生产节拍产生相位锁定
  const qrng = new Rng(seed ^ 0x5bf03635);
  const days = workingDays();
  const lots = new Map<string, LotState>();
  const ops: InternalOp[] = [];
  const mes: MesRecord[] = [];
  const wms: WmsRecord[] = [];
  const qms: QmsRecord[] = [];
  const serials: Serial[] = [];
  const shipments: ShipmentRecord[] = [];
  const injected: InjectedIssue[] = [];
  const complaints: Complaint[] = [];

  const heats: LotState[] = [];
  const sealLots: LotState[] = [];
  const pistonLots: LotState[] = [];
  const blanks: LotState[] = [];
  const bodies: LotState[] = [];
  const assyLots: LotState[] = [];
  const finished: LotState[] = [];
  const pendingRework: { lot: LotState; dayIndex: number; stage: StageCode }[] = [];

  let daySeq = 0;
  let heatSeq = 0;
  let purchaseSeq = 0;
  let serialSeq = 0;
  let workOrderSeq = 0;
  let qmsSeq = 0;
  let wmsSeq = 0;

  const dateStr = (d: string) => d.replace(/-/g, '');
  const nextLot = (day: string): string => {
    daySeq += 1;
    return `${dateStr(day)}${pad3(daySeq)}`;
  };
  const nextWo = (day: string, stage: string): string => {
    workOrderSeq += 1;
    return `WO${dateStr(day).slice(2)}-${stage}-${pad3(workOrderSeq)}`;
  };
  const nextWmsRef = (day: string): string => {
    wmsSeq += 1;
    return `WH-${dateStr(day)}-${pad3(wmsSeq)}`;
  };

  function addLot(opts: {
    mes_lot: string; material: MaterialDef; qty: number; day: string; work_order: string;
    supplier?: string | null; rework_of?: string | null;
  }): LotState {
    const prefix = opts.material.is_raw ? '' : { CAST: 'C', MACH: 'M', ASSY: 'A', FINAL: 'F' }[opts.material.stage];
    const lot: LotState = {
      lot_no: prefix + opts.mes_lot,
      mes_lot: opts.mes_lot,
      material: opts.material,
      qty_produced: opts.qty,
      qty_remaining: opts.qty,
      production_date: opts.day,
      work_order: opts.work_order,
      supplier: opts.supplier ?? null,
      serials: [],
      rework_of: opts.rework_of ?? null,
      stock_ref: null
    };
    lots.set(lot.lot_no, lot);
    return lot;
  }

  function available(pool: LotState[], day: string, allowSameDay = false): number {
    return round(
      pool
        .filter((l) => l.qty_remaining > 0.001 && (allowSameDay || l.production_date < day))
        .reduce((s, l) => s + l.qty_remaining, 0),
      4
    );
  }

  /** 优先单批投料（同批号足量则只用这一批），不足时才并入下一批 */
  function takeSingle(pool: LotState[], day: string, want: number, allowSameDay = false): { lot: LotState; qty: number }[] {
    const eligible = pool
      .filter((l) => l.qty_remaining > 0.001 && (allowSameDay || l.production_date < day))
      .sort((a, b) => (a.production_date + a.lot_no).localeCompare(b.production_date + b.lot_no));
    const first = eligible[0];
    if (first && first.qty_remaining >= want * 0.8) {
      const q = round(Math.min(first.qty_remaining, want), 4);
      first.qty_remaining = round(first.qty_remaining - q, 4);
      return [{ lot: first, qty: q }];
    }
    return take(pool, day, want, allowSameDay);
  }

  function take(pool: LotState[], day: string, want: number, allowSameDay = false): { lot: LotState; qty: number }[] {
    const eligible = pool
      .filter((l) => l.qty_remaining > 0.001 && (allowSameDay || l.production_date < day))
      .sort((a, b) => (a.production_date + a.lot_no).localeCompare(b.production_date + b.lot_no));
    const picked: { lot: LotState; qty: number }[] = [];
    let need = want;
    for (const l of eligible) {
      if (need <= 0.001) break;
      const q = round(Math.min(l.qty_remaining, need), 4);
      l.qty_remaining = round(l.qty_remaining - q, 4);
      picked.push({ lot: l, qty: q });
      need = round(need - q, 4);
    }
    return picked;
  }

  function restore(picked: { lot: LotState; qty: number }[]): void {
    for (const p of picked) p.lot.qty_remaining = round(p.lot.qty_remaining + p.qty, 4);
  }

  function recordOp(opts: {
    day: string; stage: StageCode; item: MaterialDef; wo: string; alloc: 'BLEND' | 'ASSEMBLY';
    inputs: { lot: LotState; qty: number; role: InputRole }[];
    outputs: { lot: LotState; qty: number }[];
    scrap: number; scrapUom: string; flow: FlowType; equipment: string; operator: string;
    params: Record<string, string | number>; serials?: string[]; minuteOfDay: number;
    quality_flags?: string[];
  }): InternalOp {
    const primary = opts.outputs[0].lot;
    const ts = `${opts.day} ${String(Math.floor(opts.minuteOfDay / 60)).padStart(2, '0')}:${String(opts.minuteOfDay % 60).padStart(2, '0')}:00`;
    const eventTime = toUtcIso(ts);
    const op: InternalOp = {
      op_id: `MES-${primary.mes_lot}`,
      mes_id: `MES-${primary.mes_lot}`,
      work_order: opts.wo,
      stage: opts.stage,
      item_code: opts.item.mes_code,
      alloc_mode: opts.alloc,
      equipment: opts.equipment,
      operator: opts.operator,
      event_time: eventTime,
      source_time: ts,
      source_system: 'MES' as SourceSystem,
      flow_type: opts.flow,
      scrap_qty: round(opts.scrap, 4),
      scrap_uom: opts.scrapUom,
      params: opts.params,
      quality_flags: opts.quality_flags ?? [],
      inputs: opts.inputs.map((i) => ({ lot: i.lot.lot_no, qty: round(i.qty, 4), uom: i.lot.material.uom, role: i.role })),
      outputs: opts.outputs.map((o) => ({ lot: o.lot.lot_no, qty: round(o.qty, 4), uom: o.lot.material.uom }))
    };
    ops.push(op);
    mes.push({
      mes_id: op.mes_id,
      work_order: op.work_order,
      op_code: { CAST: 'OP10', MACH: 'OP20', ASSY: 'OP30', FINAL: 'OP40' }[opts.stage],
      item_code: opts.item.mes_code,
      lot_no: primary.mes_lot,
      qty: round(opts.outputs.reduce((s, o) => s + o.qty, 0), 4),
      scrap_qty: round(opts.scrap, 4),
      inputs: opts.inputs.map((i) => ({ lot: i.lot.mes_lot, item_code: i.lot.material.mes_code, qty: round(i.qty, 4), uom: i.lot.material.uom })),
      outputs: opts.outputs.map((o) => ({ lot: o.lot.mes_lot, item_code: o.lot.material.mes_code, qty: round(o.qty, 4), uom: o.lot.material.uom })),
      equipment: op.equipment,
      operator: op.operator,
      collect_time: op.source_time,
      process_params: JSON.stringify(opts.params),
      serials: opts.serials,
      shift: opts.minuteOfDay < 16 * 60 ? 'A' : 'B'
    });
    return op;
  }

  function receiveWms(move: Omit<WmsRecord, 'wms_no'>): WmsRecord {
    wmsSeq += 1;
    const rec: WmsRecord = { wms_no: `WM${String(wmsSeq).padStart(6, '0')}`, ...move };
    wms.push(rec);
    return rec;
  }

  function qmsBatchCode(lotNo: string, day: string): string {
    // 原料检验走独立编码：IQ- + 炉号/采购批（去掉连字符）
    if (!/^[CMAF]\d{11}$/.test(lotNo)) return `IQ-${lotNo.replace(/-/g, '')}`;
    const line = lotNo[0] === 'C' ? '01' : lotNo[0] === 'M' ? '02' : lotNo[0] === 'A' ? '03' : '04';
    return `Q-${dateStr(day)}-${line}-${lotNo.slice(-3)}`;
  }

  function addInspection(opts: {
    type: 'IQC' | 'IPQC' | 'FQC' | 'REWORK'; lotNo: string; productCode: string;
    item: string; measured: number; lower: number; upper: number; result: 'PASS' | 'FAIL';
    day: string; minute: number;
  }) {
    qmsSeq += 1;
    const mm = String(Math.floor(opts.minute / 60)).padStart(2, '0');
    const ss = String(opts.minute % 60).padStart(2, '0');
    qms.push({
      inspection_no: `QMS${String(qmsSeq).padStart(6, '0')}`,
      batch_code: qmsBatchCode(opts.lotNo, opts.day),
      inspection_type: opts.type === 'REWORK' ? 'IPQC' : opts.type,
      product_code: opts.productCode,
      item: opts.item,
      measured_value: opts.measured,
      lower_limit: opts.lower,
      upper_limit: opts.upper,
      result: opts.result,
      inspected_at: `${opts.day.slice(8, 10)}/${opts.day.slice(5, 7)}/${opts.day.slice(0, 4)} ${mm}:${ss}`,
      inspector: rng.pick(['何静', '钱明', '吴倩'])
    });
  }

  const operators = ['张伟', '李强', '王芳', '刘洋', '陈晨', '赵敏', '孙磊', '周杰'];
  const OPC: Record<StageCode, string> = { CAST: 'OP10', MACH: 'OP20', ASSY: 'OP30', FINAL: 'OP40' };

  for (let di = 0; di < days.length; di++) {
    const day = days[di];
    daySeq = 0;

    // ---------- 原料收货 ----------
    const heatCount = di % 3 === 0 ? 2 : 1;
    for (let h = 0; h < heatCount; h++) {
      heatSeq += 1;
      const heatNo = `H-2509-${pad3(heatSeq)}`;
      const kg = rng.int(900, 1250);
      const supplier = rng.pick(RAW_SUPPLIERS);
      const lot = addLot({ mes_lot: heatNo, material: MATERIAL_BY_CODE.get('AL-ADC12')!, qty: kg, day, work_order: `PO-${heatNo}`, supplier });
      heats.push(lot);
      const ref = nextWmsRef(day);
      receiveWms({
        move_type: 'RECEIPT', material_no: '10001001', lot_ref: ref, prod_lot: heatNo,
        qty: kg, uom: 'KG', location: 'RM-A01', shipment_no: '',
        event_time_utc: toUtcIso(`${day} 07:10:00`), supplier
      });
      lot.stock_ref = ref;
      const fe = heatNo === COMPLAINT_HEAT || qrng.chance(0.07) ? qrng.float(1.05, 1.22, 3) : qrng.float(0.62, 0.95, 3);
      addInspection({
        type: 'IQC', lotNo: heatNo, productCode: 'R01', item: '含铁量Fe(%)',
        measured: round(fe, 3), lower: 0.5, upper: 1.0, result: fe > 1.0 ? 'FAIL' : 'PASS',
        day, minute: 7 * 60 + 40
      });
    }

    if (di % 4 === 0) {
      for (const code of ['SEAL-KIT', 'PISTON'] as const) {
        purchaseSeq += 1;
        const mat = MATERIAL_BY_CODE.get(code)!;
        const qty = rng.int(2400, 3200);
        const lotNo = `${code === 'SEAL-KIT' ? 'SK' : 'PT'}-2509-${pad3(purchaseSeq)}`;
        const lot = addLot({ mes_lot: lotNo, material: mat, qty, day, work_order: `PO-${lotNo}`, supplier: '博世密封件(苏州)' });
        const ref = nextWmsRef(day);
        receiveWms({
          move_type: 'RECEIPT', material_no: mat.wms_code, lot_ref: ref, prod_lot: lotNo,
          qty, uom: 'PCS', location: code === 'SEAL-KIT' ? 'RM-B02' : 'RM-B03',
          shipment_no: '', event_time_utc: toUtcIso(`${day} 07:30:00`), supplier: '博世密封件(苏州)'
        });
        lot.stock_ref = ref;
        (code === 'SEAL-KIT' ? sealLots : pistonLots).push(lot);
        addInspection({
          type: 'IQC', lotNo: lotNo, productCode: mat.qms_code, item: '外观/尺寸抽检',
          measured: round(qrng.float(0.005, 0.04), 3), lower: 0, upper: 0.05, result: 'PASS', day, minute: 8 * 60
        });
      }
    }

    // ---------- 熔炼铸造 ----------
    const castOpsToday = rng.weighted([{ item: 1, weight: 50 }, { item: 2, weight: 50 }]);
    for (let c = 0; c < castOpsToday; c++) {
      if (available(heats, day, true) < 300) break;
      // 一炉一炉投：优先用单炉料，不足时才并入下一炉（合批）
      const ordered = heats
        .filter((h) => h.qty_remaining > 0.001 && h.production_date <= day)
        .sort((a, b) => (a.production_date + a.lot_no).localeCompare(b.production_date + b.lot_no));
      const first = ordered[0];
      const targetKg = first && first.qty_remaining >= 600
        ? Math.floor(Math.min(first.qty_remaining, rng.int(950, 1350)))
        : rng.int(950, 1350);
      const picked = take(heats, day, targetKg, true);
      const kgIn = round(picked.reduce((s, p) => s + p.qty, 0), 3);
      if (kgIn < 300) {
        restore(picked);
        break;
      }
      const pcs = Math.floor((kgIn * CAST_YIELD) / KG_PER_BLANK);
      if (pcs < 80) {
        restore(picked);
        continue;
      }
      const scrapKg = round(kgIn - pcs * KG_PER_BLANK, 3);
      const wo = nextWo(day, 'CAST');
      const blankMat = MATERIAL_BY_CODE.get('CAL-BLANK')!;
      const split = pcs > 300 && rng.chance(0.3);
      const parts = split ? [Math.floor(pcs * rng.float(0.4, 0.6, 2)), 0] : [pcs];
      if (split) parts[1] = pcs - parts[0];
      const outLots = parts.map((q) => {
        const l = addLot({ mes_lot: nextLot(day), material: blankMat, qty: q, day, work_order: wo });
        blanks.push(l);
        return { lot: l, qty: q };
      });
      recordOp({
        day, stage: 'CAST', item: blankMat, wo, alloc: 'BLEND',
        flow: split ? 'SPLIT' : picked.length > 1 ? 'MERGE' : 'NORMAL',
        inputs: picked.map((p) => ({ lot: p.lot, qty: p.qty, role: 'BLEND' as InputRole })),
        outputs: outLots, scrap: scrapKg, scrapUom: 'KG', equipment: `FURNACE-${rng.int(1, 3)}`,
        operator: rng.pick(operators),
        params: {
          熔炼温度: rng.int(690, 730), 保温时间min: rng.int(25, 55), 浇注温度: rng.int(660, 700),
          模具号: `M-${rng.int(11, 28)}`, 单件重量kg: KG_PER_BLANK, 炉次: `${dateStr(day)}-${c + 1}`
        },
        minuteOfDay: 8 * 60 + c * 180 + rng.int(0, 40)
      });
      addInspection({
        type: 'IPQC', lotNo: outLots[0].lot.lot_no, productCode: blankMat.qms_code, item: '毛坯硬度HB',
        measured: round(qrng.float(78, 96), 1), lower: 75, upper: 105, result: 'PASS', day, minute: 9 * 60 + c * 60
      });
    }

    // ---------- 机加 ----------
    for (let m = 0; m < 2; m++) {
      if (available(blanks, day) < 60) break;
      const picked = takeSingle(blanks, day, rng.int(240, 360));
      const inPcs = Math.round(picked.reduce((s, p) => s + p.qty, 0));
      if (inPcs < 60) {
        restore(picked);
        break;
      }
      const outPcs = Math.floor(inPcs * (1 - rng.float(0.015, 0.035, 3)));
      const scrap = inPcs - outPcs;
      const wo = nextWo(day, 'MACH');
      const bodyMat = MATERIAL_BY_CODE.get('CAL-BODY')!;
      const split = outPcs > 150 && rng.chance(0.25);
      const parts = split ? [Math.floor(outPcs * 0.55), 0] : [outPcs];
      if (split) parts[1] = outPcs - parts[0];
      const outLots = parts.map((q) => {
        const l = addLot({ mes_lot: nextLot(day), material: bodyMat, qty: q, day, work_order: wo });
        bodies.push(l);
        return { lot: l, qty: q };
      });
      const op = recordOp({
        day, stage: 'MACH', item: bodyMat, wo, alloc: 'BLEND',
        flow: split ? 'SPLIT' : picked.length > 1 ? 'MERGE' : 'NORMAL',
        inputs: picked.map((p) => ({ lot: p.lot, qty: p.qty, role: 'MAIN' as InputRole })),
        outputs: outLots, scrap, scrapUom: 'PCS', equipment: `MC-${rng.int(1, 6)}`, operator: rng.pick(operators),
        params: {
          '主轴转速rpm': rng.int(3200, 4800), '进给mm/min': rng.int(180, 320), 刀具寿命剩余: rng.int(8, 92),
          活塞孔直径mm: rng.float(38.01, 38.03, 3), 同轴度mm: rng.float(0.005, 0.02, 4)
        },
        minuteOfDay: 10 * 60 + m * 150 + rng.int(0, 30)
      });
      const dim = qrng.chance(0.2) ? qrng.float(0.021, 0.035, 4) : qrng.float(0.001, 0.018, 4);
      const failIpqc = dim > 0.02;
      addInspection({
        type: 'IPQC', lotNo: outLots[0].lot.lot_no, productCode: bodyMat.qms_code, item: '活塞孔位置度(mm)',
        measured: round(dim, 4), lower: 0, upper: 0.02, result: failIpqc ? 'FAIL' : 'PASS',
        day, minute: 12 * 60 + m * 30
      });
      if (failIpqc && outLots[0].lot.qty_remaining > 40 && rng.chance(0.9)) {
        pendingRework.push({ lot: outLots[0].lot, dayIndex: di + 1, stage: 'MACH' });
      }
    }

    // ---------- 返工 ----------
    const due = pendingRework.filter((p) => p.dayIndex <= di);
    for (const p of due) {
      if (p.lot.qty_remaining < 20) continue;
      const qty = Math.round(p.lot.qty_remaining);
      p.lot.qty_remaining = round(p.lot.qty_remaining - qty, 4);
      const out = Math.floor(qty * 0.97);
      if (out <= 0) {
        p.lot.qty_remaining = round(p.lot.qty_remaining + qty, 4);
        continue;
      }
      const wo = nextWo(day, 'RWK');
      const rwLot = addLot({
        mes_lot: nextLot(day), material: p.lot.material, qty: out, day, work_order: wo, rework_of: p.lot.lot_no
      });
      if (p.stage === 'MACH') bodies.push(rwLot);
      else assyLots.push(rwLot);
      const reason = p.stage === 'MACH' ? '活塞孔位置度超差' : '密封面平面度超差';
      recordOp({
        day, stage: p.stage, item: p.lot.material, wo, alloc: 'BLEND', flow: 'REWORK',
        inputs: [{ lot: p.lot, qty, role: 'MAIN' }],
        outputs: [{ lot: rwLot, qty: out }], scrap: qty - out, scrapUom: 'PCS',
        equipment: 'RWK-01', operator: rng.pick(operators),
        params: { 返工原因: reason, 返工工序: `${OPC[p.stage]}-返修`, 复检结果: '合格', 原批次: p.lot.lot_no },
        minuteOfDay: 9 * 60 + rng.int(0, 40),
        quality_flags: ['REWORK']
      });
      addInspection({
        type: 'REWORK', lotNo: p.lot.lot_no, productCode: p.lot.material.qms_code, item: '返工复检-活塞孔位置度(mm)',
        measured: qrng.float(0.002, 0.012, 4), lower: 0, upper: 0.02, result: 'PASS', day, minute: 10 * 60
      });
    }
    for (const p of due) {
      const i = pendingRework.indexOf(p);
      if (i >= 0) pendingRework.splice(i, 1);
    }

    // ---------- 装配 ----------
    const assyOps = rng.int(2, 3);
    for (let a = 0; a < assyOps; a++) {
      const bodyAvail = Math.floor(available(bodies, day));
      if (bodyAvail < 50) break;
      const sealAvail = Math.floor(available(sealLots, day, true));
      const pistonAvail = Math.floor(available(pistonLots, day, true));
      const attempt = Math.min(rng.int(220, 330), bodyAvail, sealAvail, pistonAvail);
      if (attempt < 50) break;
      const bodyPicked = takeSingle(bodies, day, attempt);
      const sealPicked = take(sealLots, day, attempt, true);
      const pistonPicked = take(pistonLots, day, attempt, true);
      const mainQty = Math.round(bodyPicked.reduce((s, p) => s + p.qty, 0));
      if (mainQty !== attempt || sealPicked.length === 0 || pistonPicked.length === 0) {
        restore(bodyPicked);
        restore(sealPicked);
        restore(pistonPicked);
        break;
      }
      const outPcs = Math.floor(attempt * (1 - rng.float(0.006, 0.018, 3)));
      const scrap = attempt - outPcs;
      const wo = nextWo(day, 'ASSY');
      const assyMat = MATERIAL_BY_CODE.get('CAL-ASSY')!;
      const split = outPcs > 150 && rng.chance(0.2);
      const parts = split ? [Math.floor(outPcs * 0.5), 0] : [outPcs];
      if (split) parts[1] = outPcs - parts[0];
      const outLots = parts.map((q) => {
        const l = addLot({ mes_lot: nextLot(day), material: assyMat, qty: q, day, work_order: wo });
        assyLots.push(l);
        return { lot: l, qty: q };
      });
      recordOp({
        day, stage: 'ASSY', item: assyMat, wo, alloc: 'ASSEMBLY',
        flow: bodyPicked.length > 1 ? 'MERGE' : split ? 'SPLIT' : 'NORMAL',
        inputs: [
          ...bodyPicked.map((p) => ({ lot: p.lot, qty: p.qty, role: 'MAIN' as InputRole })),
          ...sealPicked.map((p) => ({ lot: p.lot, qty: p.qty, role: 'ADDITIVE' as InputRole })),
          ...pistonPicked.map((p) => ({ lot: p.lot, qty: p.qty, role: 'ADDITIVE' as InputRole }))
        ],
        outputs: outLots, scrap, scrapUom: 'PCS', equipment: `ASL-${rng.int(1, 4)}`, operator: rng.pick(operators),
        params: {
          拧紧扭矩Nm: rng.float(24.5, 26.5, 2), 密封圈压缩量mm: rng.float(0.28, 0.36, 3),
          气密测试压力bar: rng.float(5.8, 6.2, 2), 工位: `ST-${rng.int(1, 8)}`
        },
        minuteOfDay: 13 * 60 + a * 90 + rng.int(0, 30)
      });
      const flat = qrng.chance(0.1) ? qrng.float(0.052, 0.07, 4) : qrng.float(0.005, 0.045, 4);
      addInspection({
        type: 'IPQC', lotNo: outLots[0].lot.lot_no, productCode: assyMat.qms_code, item: '密封面平面度(mm)',
        measured: round(flat, 4), lower: 0, upper: 0.05, result: flat > 0.05 ? 'FAIL' : 'PASS',
        day, minute: 15 * 60 + a * 10
      });
      if (flat > 0.05 && outLots[0].lot.qty_remaining > 40 && rng.chance(0.8)) {
        pendingRework.push({ lot: outLots[0].lot, dayIndex: di + 1, stage: 'ASSY' });
      }
    }

    // ---------- 成品 ----------
    const finalOps = rng.int(2, 3);
    for (let f = 0; f < finalOps; f++) {
      const avail = available(assyLots, day);
      if (avail < 50) break;
      const picked = takeSingle(assyLots, day, Math.min(rng.int(240, 340), Math.floor(avail)));
      const inPcs = Math.round(picked.reduce((s, p) => s + p.qty, 0));
      if (inPcs < 50) {
        restore(picked);
        break;
      }
      const outPcs = Math.floor(inPcs * (1 - rng.float(0.003, 0.012, 3)));
      const scrap = inPcs - outPcs;
      const wo = nextWo(day, 'FIN');
      const finMat = MATERIAL_BY_CODE.get('CAL-FIN')!;
      const split = outPcs > 150 && rng.chance(0.2);
      const parts = split ? [Math.floor(outPcs * 0.5), 0] : [outPcs];
      if (split) parts[1] = outPcs - parts[0];
      const outLots = parts.map((q) => {
        const l = addLot({ mes_lot: nextLot(day), material: finMat, qty: q, day, work_order: wo });
        finished.push(l);
        return { lot: l, qty: q };
      });
      const allSerials: string[] = [];
      for (const o of outLots) {
        for (let i = 0; i < o.qty; i++) {
          serialSeq += 1;
          const sn = makeSerial(day, serialSeq);
          o.lot.serials.push(sn);
          allSerials.push(sn);
          serials.push({
            serial_no: sn, lot_no: o.lot.lot_no, stage: 'FINAL', produced_at: toUtcIso(`${day} 19:00:00`),
            shipment_no: null, customer_code: null, rework_count: 0, status: 'IN_STOCK'
          });
        }
      }
      recordOp({
        day, stage: 'FINAL', item: finMat, wo, alloc: 'BLEND',
        flow: split ? 'SPLIT' : picked.length > 1 ? 'MERGE' : 'NORMAL',
        inputs: picked.map((p) => ({ lot: p.lot, qty: p.qty, role: 'MAIN' as InputRole })),
        outputs: outLots, scrap, scrapUom: 'PCS', equipment: `EOL-${rng.int(1, 3)}`, operator: rng.pick(operators),
        params: {
          '泄漏率mL_min': rng.float(0.02, 0.45, 3), 制动力矩Nm: rng.float(88, 96, 1),
          序列号起始: allSerials[0], 序列号截止: allSerials[allSerials.length - 1]
        },
        serials: allSerials,
        minuteOfDay: 18 * 60 + f * 40 + rng.int(0, 20)
      });
      for (const o of outLots) {
        const leak = qrng.chance(0.07) ? qrng.float(0.52, 0.9, 3) : qrng.float(0.05, 0.45, 3);
        addInspection({
          type: 'FQC', lotNo: o.lot.lot_no, productCode: finMat.qms_code, item: '泄漏率(mL/min)',
          measured: round(leak, 3), lower: 0, upper: 0.5, result: leak > 0.5 ? 'FAIL' : 'PASS',
          day, minute: 20 * 60 + f * 5
        });
        const ref = nextWmsRef(day);
        receiveWms({
          move_type: 'TRANSFER', material_no: '10001007', lot_ref: ref, prod_lot: o.lot.lot_no,
          qty: o.qty, uom: 'PCS', location: 'FG-A01', shipment_no: '',
          event_time_utc: toUtcIso(`${day} 21:00:00`), supplier: ''
        });
        o.lot.stock_ref = ref;
      }
    }

    // ---------- 发货 ----------
    if (di % 3 === 2) {
      // 客户轮转（真实场景即按月发货计划），保证 5 家客户都有发货记录
      const cust = CUSTOMERS[shipments.length % CUSTOMERS.length];
      let remaining = rng.int(900, 1600);
      const lines: ShipmentRecord['lines'] = [];
      const candidates = finished
        .filter((l) => l.qty_remaining > 0 && l.production_date <= day)
        .sort((a, b) => (a.production_date + a.lot_no).localeCompare(b.production_date + b.lot_no));
      for (const lot of candidates) {
        if (remaining <= 0) break;
        // 按 FIFO 但只拿走 60%-90%，让部分成品留在库存，贴近真实发货节奏
        const takeRatio = rng.float(0.6, 0.9, 2);
        const q = Math.floor(Math.min(lot.qty_remaining * takeRatio, remaining));
        if (q < 10) continue;
        lot.qty_remaining = round(lot.qty_remaining - q, 4);
        const lineSerials = lot.serials.splice(0, q);
        for (const sn of lineSerials) {
          const s = serials.find((x) => x.serial_no === sn);
          if (s) {
            s.shipment_no = `SH-2509-${pad3(shipments.length + 1)}`;
            s.customer_code = cust.code;
            s.status = 'SHIPPED';
          }
        }
        lines.push({ lot_ref: lot.stock_ref ?? `WH-${dateStr(day)}-999`, qty: q, serials: lineSerials });
        remaining -= q;
      }
      if (lines.reduce((s, l) => s + l.qty, 0) >= 50) {
        shipments.push({
          shipment_no: `SH-2509-${pad3(shipments.length + 1)}`,
          customer_code: cust.code,
          customer_name: cust.name,
          ship_date: day,
          destination: cust.destination,
          carrier: rng.pick(['德邦物流', '顺丰供应链', '中远海运', '安吉物流']),
          lines
        });
        for (const line of lines) {
          receiveWms({
            move_type: 'SHIP', material_no: '10001007', lot_ref: line.lot_ref, prod_lot: null,
            qty: line.qty, uom: 'PCS', location: 'FG-DOCK', shipment_no: `SH-2509-${pad3(shipments.length)}`,
            event_time_utc: toUtcIso(`${day} 15:30:00`), supplier: ''
          });
        }
      }
    }
  }

  // ================= 数据错误注入 =================
  const dupTargets = [mes[10], mes[Math.floor(mes.length * 0.4)], mes[Math.floor(mes.length * 0.75)]].filter(Boolean);
  for (const [i, rec] of dupTargets.entries()) {
    mes.push(JSON.parse(JSON.stringify(rec)) as MesRecord);
    injected.push({ id: `INJ-DUP-${i + 1}`, kind: 'DUPLICATE_OP', target: rec.mes_id, description: `MES 导出重复记录 ${rec.mes_id}` });
  }

  for (let i = 0; i < 5; i++) {
    const rec = mes[Math.floor((i + 1) * 17) % mes.length];
    rec.collect_time = rec.collect_time.replace(/-/g, '/');
    injected.push({ id: `INJ-TIME-${i + 1}`, kind: 'TIME_FORMAT', target: rec.mes_id, description: `MES 时间格式为 YYYY/MM/DD：${rec.collect_time}` });
  }

  // 只对“确实被 MES 投料引用过”的收货/入库注入缺失 prod_lot，
  // 否则该批次既无生产记录也无收货线索，任何算法都无法还原（不可恢复的数据错误没有考察价值）
  const consumedLots = new Set(mes.flatMap((m) => m.inputs.map((i) => i.lot)));
  const candidates = wms.filter((w) =>
    (w.move_type === 'RECEIPT' || w.move_type === 'TRANSFER') && w.prod_lot && consumedLots.has(w.prod_lot)
  );
  const wmsCandidates = candidates.length >= 4 ? candidates : wms.filter((w) => (w.move_type === 'RECEIPT' || w.move_type === 'TRANSFER') && w.prod_lot);
  const missing = [
    wmsCandidates[3], wmsCandidates[Math.floor(wmsCandidates.length * 0.5)],
    wmsCandidates[Math.floor(wmsCandidates.length * 0.72)], wmsCandidates[Math.floor(wmsCandidates.length * 0.9)]
  ].filter(Boolean);
  for (const [i, rec] of missing.entries()) {
    rec.prod_lot = null;
    injected.push({ id: `INJ-WMS-${i + 1}`, kind: 'MISSING_PROD_LOT', target: rec.wms_no, description: `WMS ${rec.move_type} 缺失 prod_lot（lot_ref=${rec.lot_ref}）` });
  }

  const typoKinds = ['SUBSTITUTE', 'TRANSPOSE', 'SUFFIX'] as const;
  for (let i = 0; i < 3; i++) {
    const rec = mes[Math.floor(mes.length * (0.2 + i * 0.2))];
    if (!rec || !rec.inputs.length) continue;
    const real = rec.inputs[0].lot;
    let wrong: string;
    if (typoKinds[i] === 'SUBSTITUTE') {
      // 数字被误敲成形近字母（0->O）
      const idx = real.lastIndexOf('0');
      wrong = idx > 0 ? real.slice(0, idx) + 'O' + real.slice(idx + 1) : `${real}O`;
    } else if (typoKinds[i] === 'TRANSPOSE') {
      wrong = real.slice(0, 6) + real[7] + real[6] + real.slice(8);
    } else {
      wrong = `${real}A`;
    }
    rec.inputs[0].lot = wrong;
    injected.push({ id: `INJ-LOT-${i + 1}`, kind: 'LOT_TYPO', target: rec.mes_id, description: `输入批次 ${real} 被录成 ${wrong}` });
  }

  const complaintHeat = complaints[0]?.heat_lot ?? COMPLAINT_HEAT;
  let conflictCount = 0;
  for (const rec of qms) {
    if (conflictCount >= 2) break;
    // 投诉炉号的 IQC 不合格必须保留，作为追溯起点（IQC 批码形如 IQ-H2509014）
    if (rec.batch_code === `IQ-${complaintHeat.replace(/-/g, '')}`) continue;
    if (rec.result === 'FAIL') {
      rec.result = 'PASS';
      conflictCount++;
      injected.push({
        id: `INJ-QMS-${conflictCount}`, kind: 'RESULT_CONFLICT', target: rec.inspection_no,
        description: `实测 ${rec.measured_value} 超出上限 ${rec.upper_limit}，结果却录为 PASS（批次 ${rec.batch_code}）`
      });
    }
  }

  const matTypo = wms.find((w) => w.move_type === 'TRANSFER');
  if (matTypo) {
    matTypo.material_no = '10001070';
    injected.push({ id: 'INJ-MAT-1', kind: 'MATERIAL_TYPO', target: matTypo.wms_no, description: `物料编码 10001007 录成 10001070（lot_ref=${matTypo.lot_ref}）` });
  }

  const qtyBad = mes[Math.floor(mes.length * 0.55)];
  if (qtyBad) {
    const good = qtyBad.qty;
    qtyBad.qty = round(qtyBad.qty + 12, 0);
    injected.push({ id: 'INJ-QTY-1', kind: 'QTY_SUM_MISMATCH', target: qtyBad.mes_id, description: `主产出数量 ${good} 与产出明细合计 ${round(qtyBad.outputs.reduce((s, o) => s + o.qty, 0), 2)} 不一致` });
  }

  // ================= 客户投诉 =================
  // 在真值图（ops/lots）上独立计算每个炉号对各成品批的贡献比例，
  // 选择“贡献比例高且已发货”的炉号作为投诉对象，使命中场景与归因一致。
  const contrib = heatContributions(ops, heats);
  const finToSerials = new Map<string, { serials: string[]; customer: string }>();
  for (const s of serials) {
    if (s.status !== 'SHIPPED' || !s.customer_code) continue;
    const cur = finToSerials.get(s.lot_no) ?? { serials: [], customer: s.customer_code };
    cur.serials.push(s.serial_no);
    finToSerials.set(s.lot_no, cur);
  }
  let chosen: { heat: string; lot: string; customer: string; serials: string[]; share: number } | null = null;
  for (const [heatLot, perFin] of contrib) {
    for (const [finLot, share] of perFin) {
      const info = finToSerials.get(finLot);
      if (!info || info.serials.length < 80) continue;
      if (share < 0.22) continue;
      // 评分：贡献比例 × 已发货量，优先“占比高且量足够大”的批次
      const score = share * Math.min(info.serials.length, 400);
      if (!chosen || score > chosen.share * Math.min(chosen.serials.length, 400)) {
        chosen = { heat: heatLot, lot: finLot, customer: info.customer, serials: info.serials, share };
      }
    }
  }
  if (chosen) {
    // 投诉炉号的 IQC 必须是不合格记录（这是 8D 的直接原因）
    const iqc = qms.find((q) => q.batch_code === `IQ-${chosen!.heat.replace(/-/g, '')}` && q.inspection_type === 'IQC');
    if (iqc) {
      iqc.result = 'FAIL';
      iqc.measured_value = 1.18;
    }
    const cust = CUSTOMERS.find((c) => c.code === chosen.customer)!;
    complaints.push({
      complaint_no: 'CC-2025-0917',
      customer_code: cust.code,
      customer_name: cust.name,
      product: 'CAL-FIN 刹车卡钳成品',
      issue: '装车后制动异响，拆检发现活塞孔同轴度超差，疑似毛坯含铁量偏高导致加工后变形',
      reported_at: '2025-09-29',
      heat_lot: chosen.heat,
      serials: chosen.serials.slice(0, 6)
    });
  }

  // ================= 整理 =================
  const lotRecords: Lot[] = [...lots.values()].map((l) => ({
    id: l.lot_no,
    lot_no: l.lot_no,
    material_code: l.material.code,
    material_name: l.material.name,
    stage: l.material.stage,
    qty_produced: round(l.qty_produced, 3),
    qty_remaining: round(l.qty_remaining, 3),
    uom: l.material.uom,
    production_date: l.production_date,
    work_order: l.work_order,
    supplier: l.supplier ?? undefined,
    is_raw: l.material.is_raw,
    suspect: 0,
    suspect_reason: null
  }));

  const truthOps: OperationRow[] = ops.map(({ mes_id, ...rest }) => rest);
  const stats = {
    lots: lotRecords.length,
    raw_lots: lotRecords.filter((l) => l.is_raw).length,
    operations: ops.length,
    finished_lots: lotRecords.filter((l) => l.stage === 'FINAL').length,
    serials: serials.length,
    shipments: shipments.length,
    shipped_qty: serials.filter((s) => s.status === 'SHIPPED').length,
    inspections: qms.length,
    failed_inspections: qms.filter((q) => q.result === 'FAIL').length,
    injected_issues: injected.length
  };

  return {
    exports: { mes, wms, qms, shipments, materials: [] },
    truth: {
      generated_at: '2025-09-30T23:59:59Z',
      days,
      lots: lotRecords,
      operations: truthOps,
      serials,
      shipments,
      inspections: qms,
      complaints,
      injected,
      stats
    }
  };
}

/**
 * 真值归因：对每个原料炉号单独做正向传播，得到其对各成品批的贡献比例。
 * 与生产代码的传播实现完全独立，用于选出投诉场景与校验归因。
 */
function heatContributions(ops: OperationRow[], heats: LotState[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const heat of heats) {
    const frac = new Map<string, number>([[heat.lot_no, 1]]);
    for (let round = 0; round < 6; round++) {
      let changed = false;
      for (const op of ops) {
        const totalOut = op.outputs.reduce((x, o) => x + o.qty, 0);
        if (totalOut <= 0) continue;
        const assembly = op.alloc_mode === 'ASSEMBLY';
        const groups = new Map<string, number>();
        for (const i of op.inputs) {
          const g = assembly ? (i.material ?? 'U') : 'ALL';
          groups.set(g, (groups.get(g) ?? 0) + i.qty);
        }
        for (const o of op.outputs) {
          let best = 0;
          for (const [g, total] of groups) {
            let f = 0;
            for (const i of op.inputs) {
              const ig = assembly ? (i.material ?? 'U') : 'ALL';
              if (ig !== g) continue;
              f += (frac.get(i.lot) ?? 0) * (i.qty / (total || 1));
            }
            best = Math.max(best, f * (o.qty / totalOut));
          }
          if (best <= 1e-9) continue;
          const next = Math.min(1, best);
          if (next > (frac.get(o.lot) ?? 0) + 1e-9) {
            frac.set(o.lot, next);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    const perFin = new Map<string, number>();
    for (const [lot, f] of frac) if (f > 1e-9) perFin.set(lot, f);
    out.set(heat.lot_no, perFin);
  }
  return out;
}
