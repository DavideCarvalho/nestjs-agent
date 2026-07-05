import type { ReactNode } from 'react';

/** A titled surface with an optional right-aligned control and subtitle. */
export function Panel({
  title,
  subtitle,
  right,
  children,
  className,
}: {
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel rise p-4 ${className ?? ''}`}>
      {(title || right) && (
        <header className="mb-3 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-sm font-semibold tracking-tight">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-[var(--muted)]">{subtitle}</p>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

/** A headline number with a label and optional sub-line. */
export function Stat({
  label,
  value,
  sub,
  icon,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: ReactNode;
  tone?: 'accent' | 'good' | 'warn' | 'bad';
}) {
  const toneColor =
    tone === 'good'
      ? 'text-[var(--good)]'
      : tone === 'warn'
        ? 'text-[var(--warn)]'
        : tone === 'bad'
          ? 'text-[var(--bad)]'
          : 'text-[var(--text)]';
  return (
    <div className="panel p-4">
      <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-[var(--muted)]">
        {icon}
        {label}
      </div>
      <div className={`mono tnum text-2xl font-semibold ${toneColor}`}>{value}</div>
      {sub && <div className="mono mt-1 text-[11px] text-[var(--muted)]">{sub}</div>}
    </div>
  );
}

/** A thin progress meter. `ratio` clamps to [0,1] for the fill; `over` recolors an over-budget bar. */
export function BarMeter({
  ratio,
  over,
  className,
}: {
  ratio: number;
  over?: boolean;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0)) * 100;
  return (
    <div className={`bar-track h-2 ${className ?? ''}`}>
      <div
        className="bar-fill"
        style={{
          width: `${pct}%`,
          ...(over ? { background: 'linear-gradient(90deg,#f87171,#fbbf24)' } : {}),
        }}
      />
    </div>
  );
}

/** A small pill for a status string, colored by the `.s-*` hues in index.css. */
export function StatusPill({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const live = normalized === 'running' || normalized === 'pending';
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px]">
      <span className={`dot s-${normalized} ${live ? 'pulse' : ''}`} aria-hidden />
      <span className={`s-${normalized} uppercase tracking-wider`}>{status}</span>
    </span>
  );
}

/** An empty-state row for a section that has no data yet. */
export function Empty({ label }: { label: string }) {
  return (
    <div className="grid place-items-center rounded-lg border border-dashed border-[var(--line)] py-10 text-xs text-[var(--muted)]">
      {label}
    </div>
  );
}

/** A short "Nm ago" relative stamp for an ISO instant or epoch-ms. */
export function relTime(at: string | number): string {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
