import type { StoredMessage } from '@dudousxd/nestjs-agent-core';
import type { UIMessage } from 'ai';
import { storedMessageToUiMessage } from './stored-message-to-ui-message.js';

/**
 * Summed usage/cost across the stored-message rows merged into one turn (see
 * {@link storedThreadToUiMessages}). Mirrors `MessageUsage`, but `costUsd` is always present
 * (never omitted) since it's a computed aggregate, not a single provider report.
 */
export interface AggregatedTurnUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * `null` only when EVERY merged row reports a null/absent cost (no pricing store bound, or an
   * unpriced model) — same "unknown, not a real $0" distinction `MessageUsage.costUsd` makes for a
   * single row. A null cost on SOME rows (mixed with priced ones) contributes `0` to the sum
   * instead of poisoning the whole turn's total to `null` — the tokens are still real and summed
   * either way, so only the cost figure would be understated, never wrong in a "$0 turn" sense.
   */
  costUsd: number | null;
}

/** Metadata the grouped `UIMessage` carries on `.metadata.usage` — see {@link AggregatedTurnUsage}. */
export interface StoredTurnMetadata {
  usage: AggregatedTurnUsage;
}

/**
 * Convert a thread's full `StoredMessage[]` history into `UIMessage[]`, merging consecutive
 * assistant rows (no user message between them) into ONE `UIMessage` per turn.
 *
 * Why: the agent loop persists one row per model iteration (see `agent-loop.ts`'s per-step
 * `persist:assistant:${i}`) — a turn with tool calls appends "I'll check that..." + tool calls,
 * then a separate final-answer row. `storedMessageToUiMessage` maps 1:1, so a reloaded thread
 * renders 2-3 assistant bubbles (each with its own cost/tokens footer) for what the LIVE stream
 * renders as one continuous response (one `UIMessage`, stepped internally — see
 * `AgentChatTransport.toChunkStream`'s `start-step`/`finish-step` bracketing). This closes that gap
 * for replayed history.
 *
 * Merge shape: each row is mapped via `storedMessageToUiMessage` (unchanged — same text-then-tool
 * part ordering per row) and the parts are concatenated in row order, so the grouped message's parts
 * read as `[row1 text?, row1 tools?, row2 text?, row2 tools?, ...]` — exactly the sequence the live
 * transport streams for the same turn. The group's `id` is the LAST row's id (the final-answer row —
 * it's the one carrying `followUps`, and what a host keys turn-level actions like "fork" or
 * "regenerate" on). Non-assistant rows (user/system) pass through `storedMessageToUiMessage`
 * unchanged, one row → one message, same as today.
 *
 * A lone assistant row between two user rows (the common case: no tool calls, or already a single
 * iteration) has nothing to merge with, so it comes back byte-for-byte identical to calling
 * `storedMessageToUiMessage` directly — no `metadata` is added for that case either, preserving
 * exact backward compatibility for hosts that read stored usage some other way.
 *
 * Only an ACTUAL merge (2+ rows) attaches `metadata.usage` — the {@link AggregatedTurnUsage} summed
 * across the merged rows' `usage` (rows without a `usage` at all, e.g. an older/test fixture, are
 * skipped rather than treated as zero-and-priced).
 *
 * Deliberately NOT reproduced: the live transport's `{type: 'step-start'}` UI parts (one per model
 * call, emitted by the AI SDK for every `start-step` chunk — see `repro-real-frames.spec.ts` for a
 * captured wire dump). Those are structural brackets `MessageItem`'s `renderParts` never renders
 * (it only special-cases text and tool parts), and `storedMessageToUiMessage` has never emitted them
 * for a single row either — inventing them here would make a merged turn diverge from a same-shaped
 * unmerged one instead of converging on it. "Indistinguishable from the live stream" is scoped to
 * what actually renders: the text/tool-call content in step order, not the step brackets around it.
 */
export function storedThreadToUiMessages(messages: StoredMessage[]): UIMessage[] {
  const turns: StoredMessage[][] = [];
  for (const message of messages) {
    const currentTurn = turns.at(-1);
    const previousRow = currentTurn?.at(-1);
    if (message.role === 'assistant' && previousRow?.role === 'assistant' && currentTurn) {
      currentTurn.push(message);
    } else {
      turns.push([message]);
    }
  }
  return turns.map(mergeTurn);
}

function mergeTurn(rows: StoredMessage[]): UIMessage {
  const lastRow = rows.at(-1);
  if (lastRow === undefined) {
    // Unreachable: `storedThreadToUiMessages` never pushes an empty turn.
    throw new Error('storedThreadToUiMessages: encountered an empty turn');
  }
  if (rows.length === 1) {
    return storedMessageToUiMessage(lastRow);
  }

  const parts: UIMessage['parts'] = rows.flatMap((row) => storedMessageToUiMessage(row).parts);
  const usage = sumUsage(rows);

  return {
    id: lastRow.id,
    role: lastRow.role,
    parts,
    ...(usage !== undefined ? { metadata: { usage } satisfies StoredTurnMetadata } : {}),
  };
}

function sumUsage(rows: StoredMessage[]): AggregatedTurnUsage | undefined {
  const usages = rows
    .map((row) => row.usage)
    .filter((usage): usage is NonNullable<typeof usage> => usage !== undefined);
  if (usages.length === 0) {
    return undefined;
  }
  const allCostsUnknown = usages.every(
    (usage) => usage.costUsd === null || usage.costUsd === undefined,
  );
  return {
    inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
    costUsd: allCostsUnknown ? null : usages.reduce((sum, usage) => sum + (usage.costUsd ?? 0), 0),
  };
}
