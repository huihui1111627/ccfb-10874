import type { ReactNode } from 'react';

export function Card({ title, hint, children, actions, className = '' }: {
  title?: ReactNode; hint?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string;
}) {
  return (
    <div className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-title">
          <span>{title}</span>
          {hint && <span className="hint">{hint}</span>}
          {actions && <span style={{ marginLeft: 'auto' }}>{actions}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'warn' | 'danger' | 'blue' }) {
  const color = tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : tone === 'danger' ? 'var(--danger)' : tone === 'blue' ? 'var(--accent)' : undefined;
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ color }}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export const STAGE_TAG: Record<string, { label: string; cls: string }> = {
  CAST: { label: '熔炼铸造', cls: 'tag-amber' },
  MACH: { label: '机加', cls: 'tag-blue' },
  ASSY: { label: '装配', cls: 'tag-purple' },
  FINAL: { label: '成品', cls: 'tag-green' }
};

export function StageTag({ stage }: { stage: string }) {
  const s = STAGE_TAG[stage] ?? { label: stage, cls: 'tag-gray' };
  return <span className={`tag ${s.cls}`}>{s.label}</span>;
}

export const FLOW_LABEL: Record<string, string> = {
  NORMAL: '正常', SPLIT: '拆批', MERGE: '合批', REWORK: '返工', SCRAP: '报废'
};

export function FlowTag({ flow }: { flow: string }) {
  const cls = flow === 'SPLIT' ? 'tag-blue' : flow === 'MERGE' ? 'tag-purple' : flow === 'REWORK' ? 'tag-amber' : flow === 'SCRAP' ? 'tag-red' : 'tag-gray';
  return <span className={`tag ${cls}`}>{FLOW_LABEL[flow] ?? flow}</span>;
}

export function SeverityTag({ severity }: { severity: string }) {
  const cls = severity === 'ERROR' ? 'tag-red' : severity === 'WARN' ? 'tag-amber' : 'tag-blue';
  return <span className={`tag ${cls}`}>{severity}</span>;
}

export function SuspectTag({ reason }: { reason: string | null }) {
  return <span className="tag tag-red" title={reason ?? ''}>可疑</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading({ text = '加载中…' }: { text?: string }) {
  return <div className="loading">{text}</div>;
}

export function ErrorBox({ error }: { error: string }) {
  return <div className="error-box">{error}</div>;
}

export function qty(n: number, digits = 0): string {
  return n.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** 统一按车间本地时间（UTC+8）展示 */
export function time(iso: string): string {
  if (!iso) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const shifted = new Date(d.getTime() + 8 * 3600 * 1000);
  return shifted.toISOString().slice(0, 19).replace('T', ' ');
}

export function money(n: number): string {
  return `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
}
