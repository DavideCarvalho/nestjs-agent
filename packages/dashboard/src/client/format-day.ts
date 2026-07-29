/**
 * Day-label formatting for the trend charts. Pure; unit-tested.
 *
 * Deliberately does NOT go through `Date`. The governance read-model hands back calendar days as
 * `YYYY-MM-DD` strings, and `new Date('2026-07-12')` parses as UTC midnight — so any browser west of
 * Greenwich renders that day as "Jul 11". A chart axis that is off by one day is worse than an
 * unformatted one, so the string is split by hand and never becomes an instant.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface CalendarDay {
  year: string;
  month: string;
  day: number;
}

function parseDay(day: string): CalendarDay | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const [, year, month, dayOfMonth] = match;
  if (!year || !month || !dayOfMonth) return null;
  const monthName = MONTHS[Number(month) - 1];
  if (!monthName) return null;
  return { year, month: monthName, day: Number(dayOfMonth) };
}

/**
 * Short axis tick: `2026-07-12` -> `Jul 12`. Anything that is not a calendar day is passed through
 * untouched so an unexpected key still labels itself rather than rendering as `Invalid Date`.
 */
export function formatDayTick(day: string): string {
  const parsed = parseDay(day);
  return parsed ? `${parsed.month} ${parsed.day}` : day;
}

/**
 * Longer label for tooltips and captions: `2026-07-12` -> `Jul 12, 2026`. Same pass-through rule as
 * {@link formatDayTick}; an empty string stays empty so a caption can render nothing at all.
 */
export function formatDayLabel(day: string): string {
  const parsed = parseDay(day);
  return parsed ? `${parsed.month} ${parsed.day}, ${parsed.year}` : day;
}
