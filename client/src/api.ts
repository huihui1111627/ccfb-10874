const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
  if (!res.ok) {
    let msg = `请求失败 ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => request<{ ok: boolean; lots: number; ready: boolean }>('/health'),
  stats: () => request<import('../../shared/types').DashboardStats>('/stats'),
  ingestStatus: () => request<{
    run: { run_id: string; run_at: string; counts: Record<string, unknown>; files: { name: string; size: number; modified: string }[]; time: unknown[] } | null;
    issues: { stage: string; severity: string; system: string; message: string; ref: string }[];
    severity_counts: { severity: string; n: number }[];
    mappings: { system: string; raw: string; normalized: string; confidence: string }[];
  }>('/ingest/status'),
  runIngest: () => request<{
    run_id: string; elapsed_ms: number; counts: Record<string, number>;
    issues: { stage: string; severity: string; system: string; message: string; ref: string }[];
    files: { name: string; size: number; modified: string }[];
    time_stats: { system: string; records: number; assumed_tz: string; fixed_formats: string[] }[];
    mappings: { system: string; values: { raw: string; normalized: string; confidence: string; count: number }[] }[];
  }>('/ingest/run', { method: 'POST', body: '{}' }),
  lots: (q = '', stage = '') => request<{ rows: LotRow[]; total: number }>(`/lots?q=${encodeURIComponent(q)}&stage=${stage}`),
  lot: (lot: string) => request<LotDetail>(`/lots/${encodeURIComponent(lot)}`),
  genealogy: (lot: string, dir = 'both', depth = 8) => request<GenealogyData>(`/genealogy/${encodeURIComponent(lot)}?dir=${dir}&depth=${depth}`),
  forward: (lot: string) => request<import('../../shared/types').ForwardTrace>('/trace/forward', { method: 'POST', body: JSON.stringify({ lot }) }),
  backward: (body: { serial?: string; lot?: string }) => request<import('../../shared/types').BackwardTrace>('/trace/backward', { method: 'POST', body: JSON.stringify(body) }),
  recall: (body: { lot?: string; serial?: string }) => request<import('../../shared/types').RecallPlan>('/recall/simulate', { method: 'POST', body: JSON.stringify(body) }),
  quality: () => request<{
    failures: (InspRow & { impact: { finished_lots: number; shipped_qty: number; in_stock_qty: number; suspect_lots: number; customers: { code: string; name: string; qty: number }[] } | null })[];
    suspect_lots: { lot_no: string; material_name: string; stage: string; suspect_reason: string }[];
    suspect_count: number;
  }>('/quality/failures'),
  validate: () => request<import('../../shared/types').ValidationResult & { op_violations: string[] }>('/validate'),
  complaint: () => request<Complaint | null>('/truth/complaint'),
  eightd: (body: { lot?: string; serial?: string; complaint_no?: string; customer?: string }) =>
    request<{ report: import('../../shared/types').EightDReport; markdown: string; file: string; download: string; bytes: number }>('/reports/8d', { method: 'POST', body: JSON.stringify(body) }),
  serials: (q = '') => request<{ serial_no: string; lot_no: string; status: string; shipment_no: string | null; customer_code: string | null }[]>(`/serials?q=${encodeURIComponent(q)}`),
  customers: () => request<{ code: string; name: string }[]>('/customers')
};

export interface LotRow {
  lot_no: string; material_code: string; material_name: string; stage: string; uom: string;
  qty_produced: number; qty_remaining: number; production_date: string; work_order: string;
  supplier: string | null; is_raw: number; suspect: number; suspect_reason: string | null;
}

export interface LotDetail {
  lot: LotRow;
  parents: { op_id: string; parent_lot: string; child_lot: string; role: string; qty_consumed: number; weight: number; stage: string; stage_name: string; flow_type: string; event_time: string; material_name: string }[];
  children: { op_id: string; parent_lot: string; child_lot: string; role: string; qty_consumed: number; weight: number; stage: string; stage_name: string; flow_type: string; event_time: string; material_name: string }[];
  inspections: { inspection_no: string; inspection_type: string; item: string; measured_value: number; lower_limit: number; upper_limit: number; result: string; inspected_at: string }[];
  shipments: { shipment_no: string; customer_name: string; ship_date: string; qty: number }[];
}

export interface GenealogyData {
  focus: string;
  nodes: {
    lot_no: string; material_name: string; material_code: string; stage: string; stage_name: string;
    qty_produced: number; qty_remaining: number; production_date: string; work_order: string;
    suspect: boolean; suspect_reason: string | null; is_raw: boolean; is_focus: boolean;
  }[];
  edges: { parent: string; child: string; op_id: string; stage: string; flow_type: string; qty_consumed: number; weight: number }[];
}

export interface InspRow {
  inspection_no: string; batch_code: string; lot_no: string; inspection_type: string; item: string;
  measured_value: number; lower_limit: number; upper_limit: number; result: string; inspected_at: string;
}

export interface Complaint {
  complaint_no: string; customer_code: string; customer_name: string; product: string;
  issue: string; reported_at: string; heat_lot: string; serials: string[];
}
