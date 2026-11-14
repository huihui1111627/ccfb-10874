/**
 * 时间归一化。
 * - MES 的 collect_time 是车间本地时间（UTC+8），不带时区
 * - WMS 是 UTC ISO 字符串
 * - QMS 是本地时间，但格式为 DD/MM/YYYY HH:mm（英式）
 * 统一输出 UTC ISO 字符串用于比较，另保留本地展示字符串。
 */
export const PLANT_TZ_OFFSET_MIN = 8 * 60; // Asia/Shanghai

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

export function toUtcIso(localYmdHms: string): string {
  const [y, mo, d] = localYmdHms.slice(0, 10).split('-').map(Number);
  const [h, mi, s] = localYmdHms.slice(11, 19).split(':').map(Number);
  const utcMs = Date.UTC(y, mo - 1, d, h, mi, s || 0) - PLANT_TZ_OFFSET_MIN * 60_000;
  return new Date(utcMs).toISOString();
}

export function utcToLocalParts(iso: string): { date: string; time: string; datetime: string } {
  const d = new Date(iso);
  const shifted = new Date(d.getTime() + PLANT_TZ_OFFSET_MIN * 60_000);
  const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  const time = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
  return { date, time, datetime: `${date} ${time}` };
}

export function localDateTimeToUtc(datetime: string): string {
  return toUtcIso(datetime.replace('T', ' '));
}

export function utcToLocalDate(iso: string): string {
  return utcToLocalParts(iso).date;
}

/** 解析 MES 时间，兼容 'YYYY-MM-DD HH:mm:ss' 与 'YYYY/MM/DD HH:mm:ss' */
export function parseMesTime(raw: string): string {
  const normalized = raw.trim().replace(/\//g, '-');
  return toUtcIso(normalized);
}

/** 解析 QMS 时间 'DD/MM/YYYY HH:mm' */
export function parseQmsTime(raw: string): string {
  const m = raw.trim().match(/(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2})/);
  if (!m) throw new Error(`QMS 时间格式无法解析: ${raw}`);
  const [, d, mo, y, h, mi] = m;
  return toUtcIso(`${y}-${mo}-${d} ${h}:${mi}:00`);
}
