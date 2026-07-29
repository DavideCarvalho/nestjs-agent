import { type ReactNode, useEffect, useState } from 'react';
import { Button } from './button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './card';
import { cn } from './cn';
import { Input } from './input';
import { Tooltip } from './tooltip';

/**
 * The console's OWN vocabulary — the handful of components shadcn has no equivalent for, rebuilt on
 * the primitives next door so they inherit the same tokens instead of restating them.
 *
 * Everything that shadcn does have (Button, Badge, Input, Table, Card, Select, Tabs, Tooltip,
 * Popover) lives in a sibling file and is imported directly; nothing is re-exported through here.
 */

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
    <Card className={cn('rise p-4', className)}>
      {(title || right) && (
        <CardHeader className="mb-3">
          <div>
            {title && <CardTitle>{title}</CardTitle>}
            {subtitle && <CardDescription>{subtitle}</CardDescription>}
          </div>
          {right}
        </CardHeader>
      )}
      <CardContent>{children}</CardContent>
    </Card>
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
      ? 'text-good'
      : tone === 'warn'
        ? 'text-warn'
        : tone === 'bad'
          ? 'text-bad'
          : 'text-foreground';
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={cn('mono tnum text-2xl font-semibold', toneColor)}>{value}</div>
      {sub && <div className="mono mt-1 text-[11px] text-muted-foreground">{sub}</div>}
    </Card>
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
    <div className={cn('h-2 overflow-hidden rounded-full bg-line', className)}>
      <div
        className={cn(
          'h-full rounded-full bg-gradient-to-r',
          over ? 'from-bad to-warn' : 'from-brand to-live',
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** What a status string MEANS, which is the only thing the console colours it by. */
export type StatusTone = 'good' | 'live' | 'bad' | 'warn';

const TONE_TEXT: Record<StatusTone, string> = {
  good: 'text-good',
  live: 'text-live',
  bad: 'text-bad',
  warn: 'text-warn',
};

/**
 * Classify a status the read-model reports.
 *
 * The SPI types these as bare `string` (a store is free to record its own), so this maps the known
 * vocabularies — run statuses and `ToolCallStatus` — and falls back to `warn` for anything else,
 * which reads as "unrecognised" rather than quietly as "fine".
 */
export function statusTone(status: string): StatusTone {
  const normalized = status.toLowerCase();
  if (/^(ok|completed|success|succeeded|executed|auto_executed|approved)$/.test(normalized)) {
    return 'good';
  }
  if (/^(running|pending|pending_approval|queued)$/.test(normalized)) return 'live';
  if (/^(forbidden|denied|failed|error|rejected|cancelled|canceled|timeout)$/.test(normalized)) {
    return 'bad';
  }
  return 'warn';
}

/** A dot that carries a tone and, when live, breathes. */
export function StatusDot({ tone, className }: { tone: StatusTone; className?: string }) {
  return (
    <span
      className={cn('dot', TONE_TEXT[tone], tone === 'live' && 'live-pulse', className)}
      aria-hidden
    />
  );
}

/** A small pill for a status string, coloured by what the status means. */
export function StatusPill({ status }: { status: string }) {
  const tone = statusTone(status);
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px]">
      <StatusDot tone={tone} />
      <span className={cn('uppercase tracking-wider', TONE_TEXT[tone])}>{status}</span>
    </span>
  );
}

/**
 * A cell that opens the row's drill-down.
 *
 * Renders as plain text when `onOpen` is absent, which is the honest state for a row that has
 * nothing to open — a tool call recorded before calls carried a run id has no run to show, and a
 * button that does nothing is worse than no button. Same reason it is used in the mock-data preview,
 * where no drill-down provider exists.
 */
export function OpenCell({
  label,
  onOpen,
  title,
}: {
  label: string;
  onOpen?: (() => void) | undefined;
  title?: string;
}) {
  const full = title ?? label;
  if (onOpen === undefined) {
    return (
      <Tooltip label={full}>
        <span className="block truncate text-foreground">{label}</span>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={full}>
      <button
        type="button"
        onClick={onOpen}
        className="max-w-full truncate text-left text-foreground underline decoration-line decoration-dotted underline-offset-4 transition-colors hover:text-brand hover:decoration-brand"
      >
        {label}
      </button>
    </Tooltip>
  );
}

/** An empty-state row for a section that has no data yet. */
export function Empty({ label }: { label: string }) {
  return (
    <div className="grid place-items-center rounded-lg border border-dashed border-line py-10 text-xs text-muted-foreground">
      {label}
    </div>
  );
}

/** Prev/next pager with "page X of Y" (derived from `total`/`pageSize`) — disables at either bound. */
export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="mono mt-3 flex items-center justify-end gap-2 text-[11px] text-muted-foreground">
      <Button size="xs" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Prev
      </Button>
      <span className="tnum">
        page {page} of {pageCount}
      </span>
      <Button size="xs" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>
        Next
      </Button>
    </div>
  );
}

/**
 * A debounced text filter input: the caller only sees `onChange` `delayMs` after typing stops, so a
 * table filter doesn't refetch on every keystroke. Re-syncs its draft when `value` changes externally
 * (e.g. a "clear filters" action).
 */
export function FilterInput({
  value,
  placeholder,
  onChange,
  delayMs = 300,
  className,
}: {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  delayMs?: number;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  // Only `draft` should re-arm the debounce timer — re-running on `onChange`/`value`/`delayMs`
  // identity would either fire early or loop.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally draft-only, see above.
  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onChange(draft), delayMs);
    return () => clearTimeout(timer);
  }, [draft]);

  return (
    <Input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      {...(placeholder === undefined ? {} : { placeholder })}
      className={cn('w-28', className)}
    />
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
