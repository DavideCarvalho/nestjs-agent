import { createParser, parseAsString, parseAsStringLiteral, useQueryState } from 'nuqs';
import { splitHash } from '../aviary-kit/url-state/hash-url';
import type { TrendMetric } from '../client/trend-summary';

/**
 * The console's view state in the URL (`#/<section>?<query>`, through the kit's
 * `NuqsHashAdapter`). Every param drops out of the URL at its default, so a section opened from a
 * plain `#/<section>` link looks exactly as before.
 */

/** The params the topbar owns (the day range), carried along when moving between sections. */
export const SHARED_KEYS = ['from', 'to'] as const;

/** The day range's URL params (`?from=2026-11-01&to=2026-11-07`); absent = the trailing 30 days. */
export const rangeParams = { from: parseAsString, to: parseAsString };

/** The current hash's query, keeping only the {@link SHARED_KEYS} (`from=…&to=…`). */
export function sharedSearch(hash: string): string {
  const current = new URLSearchParams(splitHash(hash).search);
  const kept = new URLSearchParams();
  for (const key of SHARED_KEYS) {
    const value = current.get(key);
    if (value !== null) kept.set(key, value);
  }
  return kept.toString();
}

/** A free-text filter (`?agent=`, `?tool=` …); typing rewrites the current history entry. */
export const textParam = parseAsString.withDefault('');

/**
 * A 1-based table page (`?page=3`); page 1 has no param. Paging adds a history entry. Anything but
 * a whole number from 1 up (`?page=0`, `?page=-2`, `?page=x`) is ignored, so a hand-edited link
 * lands on page 1 rather than on a read the API rejects.
 */
export const pageParam = createParser({
  parse: (value: string) => (/^[1-9]\d*$/.test(value) ? Number(value) : null),
  serialize: (page: number) => String(page),
})
  .withDefault(1)
  .withOptions({ history: 'push' });

/** `#/<section>`, with the shared params (the day range) when there are any. */
export function sectionHref(section: string, shared: string): string {
  return shared === '' ? `#/${section}` : `#/${section}?${shared}`;
}

/** The chart's metric (`?metric=totalTokens`); cost is the default. Picking one adds a history entry. */
export function useMetricParam() {
  return useQueryState(
    'metric',
    parseAsStringLiteral(['costUsd', 'totalTokens'] satisfies TrendMetric[])
      .withDefault('costUsd')
      .withOptions({ history: 'push' }),
  );
}
