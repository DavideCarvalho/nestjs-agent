import type {
  ApprovalWhere,
  GovernancePage,
  GovernancePageQuery,
  RunWhere,
  ThreadWhere,
  ToolCallWhere,
} from '@dudousxd/nestjs-agent-core';
import {
  ListQueryError,
  type OffsetPage,
  offsetPage,
  parseFilterParams,
  parsePageParams,
  rejectUnknownParams,
  resolveSort,
} from './list-api.js';

/**
 * The console's governance lists (`GET runs`, `tool-calls`, `threads`, `approvals`) on the Aviary
 * list wire: `filter[field]=value`, `page` (1-based) + `size` (default 25, clamped to 200), and a
 * `sort` that only names the store's one fixed order. They answer `{ data, meta }`. Any other
 * query param (the removed `limit` / `where[...]`, a bare `?status=`) is a 400 naming its
 * replacement, never silently ignored.
 *
 * The store SPI (`GovernancePageQuery` → `GovernancePage`) is unchanged; this module translates
 * between the wire and it.
 */

type Query = Record<string, unknown>;

/** Size policy for every governance list: default 25, at most 200. */
const SIZE = { defaultSize: 25, maxSize: 200 } as const;

/** The one order each list is read in (the only `sort` it accepts). */
export const RUNS_ORDER = '-startedAt';
export const TOOL_CALLS_ORDER = '-createdAt';
export const THREADS_ORDER = '-lastActivityAt';
export const APPROVALS_ORDER = 'requestedAt';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_FIELDS = new Set(['fromDay', 'toDay']);
const EQ = ['eq'] as const;

/**
 * Reads `filter[...]` against `fields` (field → supported operators) into the SPI's `where`.
 * `undefined` when no filter was sent. Unknown field, unsupported operator or a day bound that is
 * not `YYYY-MM-DD` → 400.
 */
function readWhere<W extends object>(
  query: Query,
  fields: Record<string, readonly string[]>,
): W | undefined {
  const filters = parseFilterParams(query, { fields });
  if (filters.length === 0) return undefined;
  const where: Record<string, string> = {};
  for (const { field, value } of filters) {
    // Every operator these lists accept takes a single value (`eq`, `contains`).
    const text = value as string;
    if (DAY_FIELDS.has(field) && !ISO_DAY.test(text)) {
      throw new ListQueryError(`Invalid filter: "filter[${field}]" must be YYYY-MM-DD.`);
    }
    where[field] = text;
  }
  return where as W;
}

/**
 * Accepts only the list's fixed order (`order`, e.g. `-startedAt`), or no `sort` at all. Any other
 * field, a reversed direction or extra keys → 400: the stores read in one order only.
 */
function assertFixedSort(raw: unknown, order: string): void {
  const field = order.replace(/^-/, '');
  const direction = order.startsWith('-') ? 'desc' : 'asc';
  const items = resolveSort(raw, { sortable: [field], default: order });
  const [first] = items;
  if (items.length !== 1 || first?.direction !== direction) {
    throw new ListQueryError(`Invalid "sort": this list is always sorted by "${order}".`);
  }
}

/** The params every governance list reads. */
const LIST_PARAMS = ['page', 'size', 'sort', 'filter'] as const;

/** A list endpoint's parsed request, ready for the governance SPI. */
function pageQuery<W>(query: Query, where: W | undefined, order: string): GovernancePageQuery<W> {
  rejectUnknownParams(query, LIST_PARAMS);
  assertFixedSort(query.sort, order);
  const { page, size } = parsePageParams(query, SIZE);
  return { page, pageSize: size, ...(where !== undefined ? { where } : {}) };
}

/** `GET tool-calls`: `filter[toolName|toolType|status|threadId|fromDay|toDay]`, newest first. */
export function parseToolCallsQuery(query: Query): GovernancePageQuery<ToolCallWhere> {
  const where = readWhere<ToolCallWhere>(query, {
    toolName: EQ,
    toolType: EQ,
    status: EQ,
    threadId: EQ,
    fromDay: EQ,
    toDay: EQ,
  });
  return pageQuery(query, where, TOOL_CALLS_ORDER);
}

/**
 * `GET threads`: `filter[actorRef|fromDay|toDay]` and `filter[title][contains]` (a
 * case-insensitive substring match), newest activity first.
 */
export function parseThreadsQuery(query: Query): GovernancePageQuery<ThreadWhere> {
  const where = readWhere<ThreadWhere>(query, {
    actorRef: EQ,
    title: ['contains'],
    fromDay: EQ,
    toDay: EQ,
  });
  return pageQuery(query, where, THREADS_ORDER);
}

/** `GET runs`: `filter[agentName|status|errorCode|threadId|fromDay|toDay]`, newest first. */
export function parseRunsQuery(query: Query): GovernancePageQuery<RunWhere> {
  const where = readWhere<RunWhere>(query, {
    agentName: EQ,
    status: EQ,
    errorCode: EQ,
    threadId: EQ,
    fromDay: EQ,
    toDay: EQ,
  });
  return pageQuery(query, where, RUNS_ORDER);
}

/**
 * `GET approvals`: `filter[toolName|threadId|actorRef|agentName|fromDay|toDay]`, OLDEST first —
 * an inbox drains from the back.
 */
export function parseApprovalsQuery(query: Query): GovernancePageQuery<ApprovalWhere> {
  const where = readWhere<ApprovalWhere>(query, {
    toolName: EQ,
    threadId: EQ,
    actorRef: EQ,
    agentName: EQ,
    fromDay: EQ,
    toDay: EQ,
  });
  return pageQuery(query, where, APPROVALS_ORDER);
}

/** A governance SPI page as the list wire's `{ data, meta }`. */
export function toListPage<TRow>(page: GovernancePage<TRow>): OffsetPage<TRow> {
  return offsetPage(page.rows, { total: page.total, page: page.page, size: page.pageSize });
}

/**
 * `size` for a top-N widget (`GET top-threads`): default `fallback`, clamped to 200; anything but a
 * whole number of at least 1 → 400. A widget is not a list, so `page`, `filter`, `sort` or any
 * param outside `size` and the widget's own `params` (e.g. its `from` / `to` window) is a 400.
 */
export function parseTopSize(
  query: Query,
  fallback: number,
  params: readonly string[] = [],
): number {
  rejectUnknownParams(query, ['size', ...params]);
  return parsePageParams({ size: query.size }, { defaultSize: fallback, maxSize: 200 }).size;
}
