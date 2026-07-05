/** Compact-number + currency formatting for the console. Pure; unit-tested. */

/** Format a USD amount. Small amounts keep more precision; large ones read as `$1.2k` / `$3.4M`. */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return '$0.00';
  const abs = Math.abs(amount);
  if (abs >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(amount / 1_000).toFixed(2)}k`;
  if (abs > 0 && abs < 0.01) return '<$0.01';
  return `$${amount.toFixed(2)}`;
}

/** Format a token/count with compact suffixes (`1.2k`, `3.4M`, `1.1B`). */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${Math.round(value)}`;
}

/** Format a 0..1 ratio as an integer percent (`0.1234` -> `12%`). */
export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return '0%';
  return `${Math.round(ratio * 100)}%`;
}
