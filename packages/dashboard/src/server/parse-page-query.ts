import type {
  ApprovalWhere,
  RunWhere,
  ThreadWhere,
  ToolCallWhere,
} from '@dudousxd/nestjs-agent-core';
import { BadRequestException } from '@nestjs/common';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Parse a `page` query param (1-based); falls back to 1 when absent or not a positive integer. */
export function parsePageNumber(value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return parsed;
}

/** Rejects a `where[<field>]` whose field name isn't in `allowed`, naming the offending field. */
function assertKnownFields(raw: Record<string, string>, allowed: readonly string[]): void {
  for (const field of Object.keys(raw)) {
    if (!allowed.includes(field)) {
      throw new BadRequestException(`Unknown where field "${field}".`);
    }
  }
}

/** Rejects a day-bound `where[<field>]` that isn't `YYYY-MM-DD`, mirroring the range endpoints' check. */
function assertDayFields(raw: Record<string, string>, dayFields: readonly string[]): void {
  for (const field of dayFields) {
    const value = raw[field];
    if (value !== undefined && !ISO_DAY.test(value)) {
      throw new BadRequestException(`"where[${field}]" must be YYYY-MM-DD.`);
    }
  }
}

const DAY_FIELDS = ['fromDay', 'toDay'] as const;
const TOOL_CALL_WHERE_FIELDS = [
  'toolName',
  'toolType',
  'status',
  'threadId',
  'fromDay',
  'toDay',
] as const;

/**
 * Parse `GET tool-calls-page`'s `where[...]` query params into a `ToolCallWhere`. `undefined` (no
 * `where` params at all) means no filter. Throws `BadRequestException` on an unknown field name or a
 * malformed day bound.
 */
export function parseToolCallWhere(
  raw: Record<string, string> | undefined,
): ToolCallWhere | undefined {
  if (raw === undefined || Object.keys(raw).length === 0) return undefined;
  assertKnownFields(raw, TOOL_CALL_WHERE_FIELDS);
  assertDayFields(raw, DAY_FIELDS);
  return {
    ...(raw.toolName !== undefined ? { toolName: raw.toolName } : {}),
    ...(raw.toolType !== undefined ? { toolType: raw.toolType } : {}),
    ...(raw.status !== undefined ? { status: raw.status } : {}),
    ...(raw.threadId !== undefined ? { threadId: raw.threadId } : {}),
    ...(raw.fromDay !== undefined ? { fromDay: raw.fromDay } : {}),
    ...(raw.toDay !== undefined ? { toDay: raw.toDay } : {}),
  };
}

const THREAD_WHERE_FIELDS = ['actorRef', 'title', 'fromDay', 'toDay'] as const;

/**
 * Parse `GET threads-page`'s `where[...]` query params into a `ThreadWhere`. `undefined` means no
 * filter. Throws `BadRequestException` on an unknown field name or a malformed day bound.
 */
export function parseThreadWhere(raw: Record<string, string> | undefined): ThreadWhere | undefined {
  if (raw === undefined || Object.keys(raw).length === 0) return undefined;
  assertKnownFields(raw, THREAD_WHERE_FIELDS);
  assertDayFields(raw, DAY_FIELDS);
  return {
    ...(raw.actorRef !== undefined ? { actorRef: raw.actorRef } : {}),
    ...(raw.title !== undefined ? { title: raw.title } : {}),
    ...(raw.fromDay !== undefined ? { fromDay: raw.fromDay } : {}),
    ...(raw.toDay !== undefined ? { toDay: raw.toDay } : {}),
  };
}

// `threadId` was supported by every adapter's `RunWhere` but never accepted here, so "show me this
// thread's runs" — the drill-down's most obvious follow-up query — 400'd with "Unknown where field".
const RUN_WHERE_FIELDS = [
  'agentName',
  'status',
  'errorCode',
  'threadId',
  'fromDay',
  'toDay',
] as const;

/**
 * Parse `GET runs-page`'s `where[...]` query params into a `RunWhere`. `undefined` means no filter.
 * Throws `BadRequestException` on an unknown field name or a malformed day bound.
 */
export function parseRunWhere(raw: Record<string, string> | undefined): RunWhere | undefined {
  if (raw === undefined || Object.keys(raw).length === 0) return undefined;
  assertKnownFields(raw, RUN_WHERE_FIELDS);
  assertDayFields(raw, DAY_FIELDS);
  return {
    ...(raw.agentName !== undefined ? { agentName: raw.agentName } : {}),
    ...(raw.status !== undefined ? { status: raw.status } : {}),
    ...(raw.errorCode !== undefined ? { errorCode: raw.errorCode } : {}),
    ...(raw.threadId !== undefined ? { threadId: raw.threadId } : {}),
    ...(raw.fromDay !== undefined ? { fromDay: raw.fromDay } : {}),
    ...(raw.toDay !== undefined ? { toDay: raw.toDay } : {}),
  };
}

const APPROVAL_WHERE_FIELDS = [
  'toolName',
  'threadId',
  'actorRef',
  'agentName',
  'fromDay',
  'toDay',
] as const;

/**
 * Parse `GET approvals-page`'s `where[...]` query params into an `ApprovalWhere`. `undefined` means
 * no filter. Throws `BadRequestException` on an unknown field name or a malformed day bound.
 */
export function parseApprovalWhere(
  raw: Record<string, string> | undefined,
): ApprovalWhere | undefined {
  if (raw === undefined || Object.keys(raw).length === 0) return undefined;
  assertKnownFields(raw, APPROVAL_WHERE_FIELDS);
  assertDayFields(raw, DAY_FIELDS);
  return {
    ...(raw.toolName !== undefined ? { toolName: raw.toolName } : {}),
    ...(raw.threadId !== undefined ? { threadId: raw.threadId } : {}),
    ...(raw.actorRef !== undefined ? { actorRef: raw.actorRef } : {}),
    ...(raw.agentName !== undefined ? { agentName: raw.agentName } : {}),
    ...(raw.fromDay !== undefined ? { fromDay: raw.fromDay } : {}),
    ...(raw.toDay !== undefined ? { toDay: raw.toDay } : {}),
  };
}
