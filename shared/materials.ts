import type { StageCode } from './types.js';

export interface MaterialDef {
  code: string;
  name: string;
  stage: StageCode;
  uom: string;
  is_raw: boolean;
  /** 各源系统编码 */
  mes_code: string;
  wms_code: string;
  qms_code: string;
  /** 每件消耗上游基准（用于守恒校验） */
  spec: string;
}

export const MATERIALS: MaterialDef[] = [
  {
    code: 'AL-ADC12', name: 'ADC12 铝合金锭', stage: 'CAST', uom: 'kg', is_raw: true,
    mes_code: 'AL-ADC12', wms_code: '10001001', qms_code: 'R01',
    spec: '炉号收货，按 kg 计量'
  },
  {
    code: 'CAL-BLANK', name: '卡钳毛坯', stage: 'CAST', uom: '件', is_raw: false,
    mes_code: 'CAL-BLANK', wms_code: '10001002', qms_code: 'A02',
    spec: '约 2.45 kg/件'
  },
  {
    code: 'CAL-BODY', name: '卡钳机加本体', stage: 'MACH', uom: '件', is_raw: false,
    mes_code: 'CAL-BODY', wms_code: '10001003', qms_code: 'A03',
    spec: '1 件毛坯 -> 1 件本体'
  },
  {
    code: 'SEAL-KIT', name: '密封件套件', stage: 'ASSY', uom: '套', is_raw: true,
    mes_code: 'SEAL-KIT', wms_code: '10001004', qms_code: 'R04',
    spec: '外购件，每总成 1 套'
  },
  {
    code: 'PISTON', name: '活塞组件', stage: 'ASSY', uom: '件', is_raw: true,
    mes_code: 'PISTON', wms_code: '10001005', qms_code: 'R05',
    spec: '外购件，每总成 1 件'
  },
  {
    code: 'CAL-ASSY', name: '卡钳总成', stage: 'ASSY', uom: '件', is_raw: false,
    mes_code: 'CAL-ASSY', wms_code: '10001006', qms_code: 'A06',
    spec: '1 本体 + 1 密封套件 + 1 活塞'
  },
  {
    code: 'CAL-FIN', name: '刹车卡钳成品', stage: 'FINAL', uom: '件', is_raw: false,
    mes_code: 'CAL-FIN', wms_code: '10001007', qms_code: 'A07',
    spec: '1 总成 -> 1 成品，赋序列号'
  }
];

export const MATERIAL_BY_CODE = new Map(MATERIALS.map((m) => [m.code, m]));
export const MATERIAL_BY_WMS = new Map(MATERIALS.map((m) => [m.wms_code, m]));
export const MATERIAL_BY_QMS = new Map(MATERIALS.map((m) => [m.qms_code, m]));
export const MATERIAL_BY_MES = new Map(MATERIALS.map((m) => [m.mes_code, m]));

export const STAGE_NAME: Record<StageCode, string> = {
  CAST: '熔炼铸造',
  MACH: '机加',
  ASSY: '表面处理与装配',
  FINAL: '成品检验入库'
};

export const STAGE_ORDER: StageCode[] = ['CAST', 'MACH', 'ASSY', 'FINAL'];
