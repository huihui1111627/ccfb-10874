// ============ 跨前后端共享的数据契约 ============

/** 工程的四个工序：熔炼/铸造 -> 机加工 -> 表面处理/装配 -> 检验入库 */
export type StageCode = 'CAST' | 'MACH' | 'ASSY' | 'FINAL';

export interface StageDef {
  code: StageCode;
  name: string;
  system: SourceSystem;
}

export type SourceSystem = 'MES' | 'WMS' | 'QMS';

export const STAGES: StageDef[] = [
  { code: 'CAST', name: '熔炼铸造', system: 'MES' },
  { code: 'MACH', name: '机加', system: 'MES' },
  { code: 'ASSY', name: '表面处理与装配', system: 'MES' },
  { code: 'FINAL', name: '成品检验入库', system: 'QMS' }
];

// ---------- 原始导入记录（三套系统各自格式） ----------

export interface MesInput {
  /** 上游批次号（MES 格式） */
  lot: string;
  /** 物料编码（MES 格式） */
  item_code: string;
  qty: number;
  uom: string;
}

export interface MesOutput {
  lot: string;
  item_code: string;
  qty: number;
  uom: string;
}

export interface MesRecord {
  /** MES 内部主键 */
  mes_id: string;
  /** 工单号 */
  work_order: string;
  /** 工序代码 OP10/OP20/OP30/OP40 */
  op_code: string;
  /** 产出主物料编码 */
  item_code: string;
  /** 产出主批次（单产出时等于 outputs[0].lot） */
  lot_no: string;
  /** 主产出数量 */
  qty: number;
  /** 报废数量（同一物料行） */
  scrap_qty: number;
  /** 投入批次（可多行） */
  inputs: MesInput[];
  /** 产出批次（拆批时多行） */
  outputs: MesOutput[];
  /** 设备编号 */
  equipment: string;
  /** 操作工 */
  operator: string;
  /** 采集时间：本地时间，格式 YYYY-MM-DD HH:mm:ss（少量记录格式不同） */
  collect_time: string;
  /** 工艺参数 JSON 字符串 */
  process_params: string;
  /** 成品序列号，仅 OP40 有 */
  serials?: string[];
  /** 当前班次 */
  shift?: string;
}

export interface WmsRecord {
  /** WMS 单号 */
  wms_no: string;
  /** 移动类型: RECEIPT/ISSUE/TRANSFER/SHIP/SCRAP */
  move_type: string;
  /** WMS 物料号（与 MES 编码不同源） */
  material_no: string;
  /** WMS 库位标签号，10 位，如 WH-20251003-01 */
  lot_ref: string;
  /** 生产批次引用（收货时由 MES 推送），少量缺失 */
  prod_lot: string | null;
  qty: number;
  uom: string;
  location: string;
  shipment_no: string;
  /** 时间：UTC ISO 字符串 */
  event_time_utc: string;
  supplier: string;
}

export interface QmsRecord {
  /** 检验单号 */
  inspection_no: string;
  /** 报检批次（QMS 自己的编码规则：Q-YYYYMMDD-线别-流水） */
  batch_code: string;
  /** 检验类型 IQC/IPQC/FQC */
  inspection_type: string;
  /** 产品编码（QMS 用短码） */
  product_code: string;
  /** 检验项目 */
  item: string;
  measured_value: number;
  lower_limit: number;
  upper_limit: number;
  /** 结果 PASS/FAIL */
  result: string;
  /** 时间：本地时间，格式 DD/MM/YYYY HH:mm */
  inspected_at: string;
  inspector: string;
}

export interface ShipmentRecord {
  shipment_no: string;
  customer_code: string;
  customer_name: string;
  ship_date: string;
  destination: string;
  carrier: string;
  /** 发货明细 */
  lines: { lot_ref: string; qty: number; serials: string[] }[];
}

// ---------- 归一化后的实体 ----------

export interface Material {
  code: string;
  name: string;
  stage: StageCode;
  uom: string;
}

export interface Lot {
  /** 成品批次关联的序列号（仅构建期使用，不落库） */
  serials?: string[];
  id: string;
  /** 工厂统一批次号（归一化后） */
  lot_no: string;
  material_code: string;
  material_name: string;
  stage: StageCode;
  qty_produced: number;
  qty_remaining: number;
  uom: string;
  production_date: string;
  work_order: string;
  supplier?: string;
  /** 是否为采购原料 */
  is_raw: boolean;
  /** 是否可疑（质检不合格波及） */
  suspect: number;
  suspect_reason: string | null;
}

/** 批次谱系边：一次工序流转中的消耗-产出关系 */
export interface GenealogyEdge {
  id: number;
  op_id: string;
  parent_lot: string;
  child_lot: string;
  /** 本次流转从父批消耗的数量（父批 UOM） */
  qty_consumed: number;
  /** 其中进入产出的数量（父批 UOM，CAST 为 kg） */
  qty_allocated: number;
  /** 分摊到报废的数量（父批 UOM） */
  scrap_share: number;
  /** 该父批对子批的贡献权重 (0-1) */
  weight: number;
  /** 该物料行在工序中的角色 */
  role: InputRole;
  work_order: string;
  stage: StageCode;
  equipment: string;
  operator: string;
  /** 归一化 UTC 时间 */
  event_time: string;
  /** 原始时间字符串（保留可追溯性） */
  source_time: string;
  source_system: SourceSystem;
  /** 工序工艺参数 */
  params: Record<string, string | number>;
  /** 拆批/合批/返工/正常/报废 */
  flow_type: FlowType;
  /** 数据质量标记 */
  quality_flags: string[];
  /** 同一工序内同一物料组的配额键，用于装配时按物料组归一 */
  group_key: string;
}

export type InputRole = 'BLEND' | 'MAIN' | 'ADDITIVE';

export interface OperationRow {
  op_id: string;
  work_order: string;
  stage: StageCode;
  item_code: string;
  alloc_mode: 'BLEND' | 'ASSEMBLY';
  equipment: string;
  operator: string;
  event_time: string;
  source_time: string;
  source_system: SourceSystem;
  flow_type: FlowType;
  scrap_qty: number;
  scrap_uom: string;
  params: Record<string, string | number>;
  quality_flags: string[];
  inputs: { lot: string; qty: number; uom: string; role: InputRole; material?: string | null }[];
  outputs: { lot: string; qty: number; uom: string; material?: string | null }[];
}

export type FlowType = 'NORMAL' | 'SPLIT' | 'MERGE' | 'REWORK' | 'SCRAP';

export interface Serial {
  serial_no: string;
  lot_no: string;
  stage?: StageCode;
  produced_at: string;
  shipment_no: string | null;
  customer_code: string | null;
  /** 返工次数 */
  rework_count: number;
  status: 'IN_STOCK' | 'SHIPPED' | 'SCRAPPED';
}

export interface Shipment {
  shipment_no: string;
  customer_code: string;
  customer_name: string;
  ship_date: string;
  destination: string;
  carrier?: string;
  lines: ShipmentLine[];
}

export interface ShipmentLine {
  shipment_no: string;
  lot_no: string;
  serial_no?: string | null;
  qty: number;
  serials?: string[];
}

export interface Inspection {
  id: number;
  inspection_no: string;
  batch_code: string;
  lot_no: string;
  inspection_type: string;
  item: string;
  measured_value: number;
  lower_limit: number;
  upper_limit: number;
  result: 'PASS' | 'FAIL';
  inspected_at: string;
  inspector: string;
}

export interface Customer {
  code: string;
  name: string;
  region: string;
}

// ---------- 数据接入报告 ----------

export interface IngestIssue {
  stage: 'MAPPING' | 'DEDUPE' | 'TIME' | 'QTY' | 'UNMATCHED' | 'PARSE';
  severity: 'INFO' | 'WARN' | 'ERROR';
  system: SourceSystem | 'TRUTH';
  message: string;
  ref: string;
}

export interface IngestReport {
  run_at: string;
  counts: Record<string, number>;
  issues: IngestIssue[];
  code_mapping: { system: string; raw: string; normalized: string; confidence: 'EXACT' | 'RULE' | 'FUZZY' }[];
  time_alignment: { system: string; records: number; assumed_tz: string; fixed_formats: string[] }[];
}

// ---------- 追溯结果 ----------

export interface TraceNode {
  lot_no: string;
  material_code: string;
  material_name: string;
  stage: StageCode;
  depth: number;
  qty_consumed: number;
  qty_produced: number;
  event_time: string;
  work_order: string;
  flow_type: FlowType;
  suspect: boolean;
  quality_flags: string[];
}

export interface ForwardTrace {
  raw_lot: string;
  nodes: TraceNode[];
  finished_lots: {
    lot_no: string;
    material_name: string;
    qty_produced: number;
    /** 该原料批次经 BOM 展开后贡献的当量数量（按数量占比折算） */
    attributable_qty: number;
    /** 贡献极小（<0.2%）属数值噪声 */
    minor: boolean;
    shipments: {
      shipment_no: string;
      customer_code: string;
      customer_name: string;
      ship_date: string;
      qty: number;
      serials: string[];
    }[];
  }[];
  affected_customers: { code: string; name: string; qty: number; shipments: number }[];
  totals: { finished_qty: number; shipped_qty: number; in_stock_qty: number; customers: number };
  /** 计算出的可疑批次 */
  suspect_lots: string[];
  /** 受影响成品批次的序列号明细（含库存与已发货） */
  serials_by_lot: { lot_no: string; serials: string[]; shipped: number }[];
  elapsed_ms: number;
}

export interface BackwardTrace {
  serial_no: string;
  lot_no: string;
  paths: {
    raw_lot: string;
    supplier: string | null;
    material_name: string;
    /** 该路径贡献权重（0-1） */
    weight: number;
    steps: {
      lot_no: string;
      material_name: string;
      stage: StageCode;
      work_order: string;
      equipment: string;
      operator: string;
      event_time: string;
      flow_type: FlowType;
      params: Record<string, string | number>;
      quality_flags: string[];
    }[];
  }[];
  raw_lots: string[];
  shipments: { shipment_no: string; customer_name: string; ship_date: string; qty: number }[];
  /** 反向经过的全部工序，按时间排序 */
  hops: TraceHop[];
  elapsed_ms: number;
}

export interface RecallPlan {
  input_lot: string;
  input_kind: 'RAW' | 'FINISHED' | 'SERIAL';
  suspect_lots: string[];
  shipments: RecallShipment[];
  /** 按投入占比折算的受影响数量（精确归因口径） */
  total_affected_qty: number;
  /** 受影响成品批次的整批发货量（保守召回口径，安全件默认） */
  total_conservative_qty: number;
  total_shipped_qty: number;
  /** 保守口径的可拦截库存 */
  in_stock_qty: number;
  /** 折算口径的可拦截库存 */
  in_stock_attributable_qty: number;
  scrap_qty: number;
  /** 召回成本估算（保守口径，元） */
  cost_estimate: {
    unit_recall_cost: number;
    freight: number;
    rework: number;
    scrap: number;
    total: number;
  };
  /** 折算口径成本，用于对比 */
  cost_attributable: number;
  /** 未发货库存明细，可直接拦截 */
  blocked_inventory: { lot_no: string; material_name: string; qty: number; location: string }[];
  elapsed_ms: number;
}

export interface RecallShipment {
  shipment_no: string;
  customer_code: string;
  customer_name: string;
  ship_date: string;
  destination: string;
  /** 按贡献比例折算的受影响数量 */
  affected_qty: number;
  /** 该发货单涉及的全部数量（保守口径） */
  lot_qty: number;
  serials: string[];
  lots: { lot_no: string; qty: number; fraction: number; attributable: number }[];
  days_since_ship: number;
  priority: 'A' | 'B' | 'C';
}

export interface EightDReport {
  title: string;
  generated_at: string;
  header: { complaint_no: string; product: string; customer: string; issue: string };
  d1_team: string[];
  d2_problem: string;
  d3_containment: string[];
  d4_root_cause: string;
  d5_corrective: string[];
  d6_implemented: string[];
  d7_prevent: string[];
  d8_closure: string;
  attachments: { name: string; description: string }[];
  trace_summary: {
    raw_lots: { lot_no: string; supplier: string; qty: number }[];
    affected_lots: number;
    affected_serials: number;
    shipped_qty: number;
    customers: string[];
    shipments: string[];
  };
  quantity_balance: { stage: string; input: number; output: number; scrap: number; rework: number; balanced: boolean }[];
}

export interface TraceHop {
  op_id: string;
  stage: StageCode;
  stage_name: string;
  work_order: string;
  equipment: string;
  operator: string;
  event_time: string;
  flow_type: FlowType;
  quality_flags: string[];
  params: Record<string, string | number>;
  /** 本次流转的投入 */
  inputs: { lot_no: string; material_name: string; qty: number; uom: string; role: InputRole; weight: number }[];
  /** 本次流转的产出 */
  outputs: { lot_no: string; material_name: string; qty: number; uom: string }[];
  scrap_qty: number;
}

export interface ValidationResult {
  ok: boolean;
  checked_at: string;
  truth_available: boolean;
  lineage: {
    total_edges: number;
    matched_edges: number;
    missing_edges: string[];
    spurious_edges: string[];
    accuracy: number;
  };
  quantity: {
    stage: string;
    input_qty: number;
    output_qty: number;
    scrap_qty: number;
    rework_qty: number;
    variance: number;
    ok: boolean;
  }[];
  batch_level: {
    lot_no: string;
    truth_qty: number;
    traced_qty: number;
    diff: number;
    ok: boolean;
  }[];
  end_to_end: {
    raw_lot: string;
    truth_serials: number;
    traced_serials: number;
    overlap: number;
    precision: number;
    recall: number;
  }[];
  data_quality: {
    injected_issues: number;
    detected_issues: number;
    corrections_applied: number;
  };
  /** 投诉炉号 -> 各成品批次的受影响比例：真值 vs 追溯结果 */
  attribution: { lot_no: string; truth_fraction: number; traced_fraction: number; diff: number; ok: boolean }[];
}

export interface DashboardStats {
  lots: number;
  raw_lots: number;
  finished_lots: number;
  serials: number;
  shipments: number;
  customers: number;
  edges: number;
  inspections: number;
  failed_inspections: number;
  suspect_lots: number;
  date_range: { from: string; to: string };
  by_stage: { stage: string; name: string; lots: number; qty: number }[];
  daily_output: { date: string; qty: number; scrap: number }[];
}
