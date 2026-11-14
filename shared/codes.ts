/**
 * 编码归一化规则。三套系统各有一套批次编码：
 *  - MES:  20251003007        (YYYYMMDD + 3 位班次流水)
 *  - WMS:  WH-20251003-01     (收货/库位标签)
 *  - QMS:  Q-20251003-01-007  (线别 + 检验流水)
 * 归一化后的“工厂批次号”采用 MES 主干 + 工序前缀，例如 C20251003007。
 * 但真正的跨系统对齐要依靠：收货单的 prod_lot 引用、时间窗、物料编码映射三重证据。
 */
export const LOT_PREFIX: Record<string, string> = {
  CAST: 'C',
  MACH: 'M',
  ASSY: 'A',
  FINAL: 'F'
};

export function mesLotToFactoryLot(mesLot: string, stage: string): string {
  const prefix = LOT_PREFIX[stage] ?? 'X';
  return prefix + mesLot;
}

export function normalizeLotNo(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

export function normalizeMaterialCode(system: 'MES' | 'WMS' | 'QMS', raw: string): string | null {
  const v = raw.trim().toUpperCase();
  if (system === 'MES') {
    const direct = ['AL-ADC12', 'CAL-BLANK', 'CAL-BODY', 'CAL-ASSY', 'CAL-FIN', 'SEAL-KIT', 'PISTON'].includes(v);
    return direct ? v : null;
  }
  if (system === 'WMS') {
    const map: Record<string, string> = {
      '10001001': 'AL-ADC12', '10001002': 'CAL-BLANK', '10001003': 'CAL-BODY',
      '10001004': 'SEAL-KIT', '10001005': 'PISTON', '10001006': 'CAL-ASSY', '10001007': 'CAL-FIN'
    };
    return map[v] ?? null;
  }
  const map: Record<string, string> = { R01: 'AL-ADC12', A02: 'CAL-BLANK', A03: 'CAL-BODY', R04: 'SEAL-KIT', R05: 'PISTON', A06: 'CAL-ASSY', A07: 'CAL-FIN' };
  return map[v] ?? null;
}

/** 从 QMS 批次编码中解析出 MES 批次（去掉前缀和线别） */
export function qmsBatchToMesLot(qmsBatch: string): string | null {
  const m = qmsBatch.match(/Q-(\d{8})-(\d{2})-(\d{3})/);
  if (!m) return null;
  return `${m[1]}${m[3]}`;
}

/** 从 WMS 库位标签中解析出日期 */
export function wmsLotDate(ref: string): string | null {
  const m = ref.match(/WH-(\d{8})-(\d{2})/);
  return m ? m[1] : null;
}

/** 序列号格式: FIN-YYYYMMDD-##### */
export function makeSerial(date: string, seq: number): string {
  return `FIN-${date.replace(/-/g, '')}-${String(seq).padStart(5, '0')}`;
}
