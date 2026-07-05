import type { GovernanceRange } from './agent-client';

const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` UTC day string `daysAgo` days before `now` (0 = the `now` day). */
export function utcDay(daysAgo: number, now: number = Date.now()): string {
  return new Date(now - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

/** The default range the console opens on: an inclusive `spanDays`-day window ending today (UTC). */
export function defaultRange(spanDays = 30, now: number = Date.now()): GovernanceRange {
  return { fromDay: utcDay(spanDays - 1, now), toDay: utcDay(0, now) };
}

/** True for a well-formed `YYYY-MM-DD` day string. */
export function isIsoDay(value: string): boolean {
  return ISO_DAY.test(value);
}

/**
 * Number of inclusive days a range spans (`from` and `to` both counted). Returns 1 for a same-day
 * range and clamps a reversed range to 1. Pure — assumes valid `YYYY-MM-DD` inputs.
 */
export function rangeDays(range: GovernanceRange): number {
  const from = Date.parse(`${range.fromDay}T00:00:00Z`);
  const to = Date.parse(`${range.toDay}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 1;
  return Math.max(1, Math.round((to - from) / DAY_MS) + 1);
}
