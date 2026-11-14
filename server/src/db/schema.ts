export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lots (
  lot_no TEXT PRIMARY KEY,
  mes_lot TEXT,
  material_code TEXT NOT NULL,
  material_name TEXT NOT NULL,
  stage TEXT NOT NULL,
  uom TEXT NOT NULL,
  qty_produced REAL NOT NULL,
  qty_remaining REAL NOT NULL DEFAULT 0,
  production_date TEXT NOT NULL,
  work_order TEXT,
  supplier TEXT,
  is_raw INTEGER NOT NULL DEFAULT 0,
  source_system TEXT NOT NULL,
  suspect INTEGER NOT NULL DEFAULT 0,
  suspect_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_lots_stage ON lots(stage);
CREATE INDEX IF NOT EXISTS idx_lots_material ON lots(material_code);
CREATE INDEX IF NOT EXISTS idx_lots_date ON lots(production_date);

CREATE TABLE IF NOT EXISTS operations (
  op_id TEXT PRIMARY KEY,
  work_order TEXT NOT NULL,
  stage TEXT NOT NULL,
  item_code TEXT NOT NULL,
  alloc_mode TEXT NOT NULL,
  equipment TEXT,
  operator TEXT,
  event_time TEXT NOT NULL,
  source_time TEXT,
  source_system TEXT NOT NULL,
  flow_type TEXT NOT NULL,
  scrap_qty REAL NOT NULL DEFAULT 0,
  scrap_uom TEXT,
  params_json TEXT NOT NULL DEFAULT '{}',
  quality_flags TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_ops_time ON operations(event_time);
CREATE INDEX IF NOT EXISTS idx_ops_stage ON operations(stage);

CREATE TABLE IF NOT EXISTS op_inputs (
  op_id TEXT NOT NULL,
  lot_no TEXT NOT NULL,
  qty REAL NOT NULL,
  allocated REAL NOT NULL DEFAULT 0,
  uom TEXT NOT NULL,
  role TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 1,
  raw_lot TEXT,
  PRIMARY KEY (op_id, lot_no, role)
);
CREATE INDEX IF NOT EXISTS idx_op_inputs_lot ON op_inputs(lot_no);

CREATE TABLE IF NOT EXISTS op_outputs (
  op_id TEXT NOT NULL,
  lot_no TEXT NOT NULL,
  qty REAL NOT NULL,
  uom TEXT NOT NULL,
  PRIMARY KEY (op_id, lot_no)
);
CREATE INDEX IF NOT EXISTS idx_op_outputs_lot ON op_outputs(lot_no);

CREATE TABLE IF NOT EXISTS edges (
  op_id TEXT NOT NULL,
  parent_lot TEXT NOT NULL,
  child_lot TEXT NOT NULL,
  role TEXT NOT NULL,
  qty_consumed REAL NOT NULL,
  qty_allocated REAL NOT NULL,
  scrap_share REAL NOT NULL DEFAULT 0,
  weight REAL NOT NULL,
  group_key TEXT NOT NULL,
  event_time TEXT NOT NULL,
  stage TEXT NOT NULL,
  flow_type TEXT NOT NULL,
  PRIMARY KEY (op_id, parent_lot, child_lot, role)
);
CREATE INDEX IF NOT EXISTS idx_edges_parent ON edges(parent_lot);
CREATE INDEX IF NOT EXISTS idx_edges_child ON edges(child_lot);

CREATE TABLE IF NOT EXISTS serials (
  serial_no TEXT PRIMARY KEY,
  lot_no TEXT NOT NULL,
  produced_at TEXT NOT NULL,
  shipment_no TEXT,
  customer_code TEXT,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_serials_lot ON serials(lot_no);
CREATE INDEX IF NOT EXISTS idx_serials_ship ON serials(shipment_no);

CREATE TABLE IF NOT EXISTS shipments (
  shipment_no TEXT PRIMARY KEY,
  customer_code TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  ship_date TEXT NOT NULL,
  destination TEXT,
  carrier TEXT
);

CREATE TABLE IF NOT EXISTS shipment_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_no TEXT NOT NULL,
  lot_no TEXT NOT NULL,
  qty REAL NOT NULL,
  serials_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_ship_lines_lot ON shipment_lines(lot_no);

CREATE TABLE IF NOT EXISTS inspections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inspection_no TEXT NOT NULL UNIQUE,
  batch_code TEXT NOT NULL,
  lot_no TEXT,
  inspection_type TEXT NOT NULL,
  item TEXT NOT NULL,
  measured_value REAL NOT NULL,
  lower_limit REAL NOT NULL,
  upper_limit REAL NOT NULL,
  result TEXT NOT NULL,
  raw_result TEXT NOT NULL,
  inspected_at TEXT NOT NULL,
  raw_time TEXT NOT NULL,
  inspector TEXT,
  corrected INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_insp_lot ON inspections(lot_no);
CREATE INDEX IF NOT EXISTS idx_insp_result ON inspections(result);

CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  severity TEXT NOT NULL,
  system TEXT NOT NULL,
  message TEXT NOT NULL,
  ref TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issues_run ON issues(run_id);

CREATE TABLE IF NOT EXISTS code_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  system TEXT NOT NULL,
  raw TEXT NOT NULL,
  normalized TEXT NOT NULL,
  confidence TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  run_id TEXT PRIMARY KEY,
  run_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  counts_json TEXT NOT NULL
);
`;
