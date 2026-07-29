import type { UseQueryResult } from '@tanstack/react-query';
import type { GovernancePage } from '../client/agent-client';

/** The page size every paged table opens on — no pageSize selector, matching the API's default. */
export const PAGE_SIZE = 25;

/**
 * The three things a paged table has to render, in one prop.
 *
 * Paged tables are the one place in this console that deliberately does NOT use Suspense: a
 * `useSuspenseQuery` has no `placeholderData`, so every page click would unmount the table into a
 * fallback. They keep the previous page on screen instead, which means a failed fetch has to be
 * shown NEXT TO rows rather than instead of them — hence `error` travelling with `page` rather than
 * being thrown to the section's boundary.
 */
export interface PagedTable<TRow> {
  /** The newest page that loaded. Falls back to an empty page before the first one arrives. */
  page: GovernancePage<TRow>;
  /** Non-null when the LAST fetch failed. `page` may still hold the previous page's rows. */
  error: unknown;
  retry: () => void;
}

/** Adapt a paged react-query result into the shape the table components render from. */
export function pagedTable<TRow>(
  query: UseQueryResult<GovernancePage<TRow>, Error>,
  page: number,
  pageSize: number,
): PagedTable<TRow> {
  return {
    page: query.data ?? { rows: [], total: 0, page, pageSize },
    error: query.isError ? query.error : null,
    retry: () => void query.refetch(),
  };
}
