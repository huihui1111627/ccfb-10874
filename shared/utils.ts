export function pct(part: number, total: number, digits = 1): string {
  if (!total) return '0%';
  return `${((part / total) * 100).toFixed(digits)}%`;
}

export function fmtQty(n: number, digits = 0): string {
  return n.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function shortId(id: string, len = 10): string {
  return id.length > len ? `${id.slice(0, len)}…` : id;
}

export function formatLocal(iso: string): string {
  return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, '').replace('Z', '') : '—';
}

export function daysBetween(a: string, b: string): number {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}
