/**
 * The built-in {@link HistoryPolicy}: keep the newest messages that fit a count and/or a token
 * budget, and (optionally) fold the rest into a summary. See `./spi/history-policy.ts` for the seam
 * itself and the determinism contract `select` has to hold to.
 */

import type { HistoryPolicy, HistorySelection, HistorySummary } from './spi/history-policy.js';
import type { ModelProvider } from './spi/model-provider.js';
import type { SinkWriter } from './spi/token-stream-sink.js';
import type { ModelMessage } from './types.js';

/**
 * Rough token count for one message: ~4 characters per token over its content and its serialized
 * tool calls/results, plus a small per-message envelope allowance for the role and part framing.
 *
 * A heuristic on purpose. A real tokenizer is model-specific and would drag a provider dependency
 * into core, while a budget only has to be approximately right to keep a thread clear of the
 * provider's hard limit — and it must be a pure function, because it runs inside `select`. Pass
 * `estimate` to {@link windowHistory} to substitute a real one.
 */
export function estimateMessageTokens(message: ModelMessage): number {
  const extras =
    (message.toolCalls !== undefined ? JSON.stringify(message.toolCalls).length : 0) +
    (message.toolResults !== undefined ? JSON.stringify(message.toolResults).length : 0);
  return Math.ceil((message.content.length + extras) / 4) + 4;
}

export interface WindowHistoryOptions {
  /** Keep at most this many of the newest messages. Omit → no count limit. */
  maxMessages?: number;
  /** Keep the newest messages whose estimated tokens fit this budget. Omit → no token limit. */
  maxTokens?: number;
  /** Substitute for {@link estimateMessageTokens}. Must be pure — it runs inside `select`. */
  estimate?: (message: ModelMessage) => number;
  /** Folds the dropped messages into a leading summary. Omit → they are simply gone. */
  summarize?: HistoryPolicy['summarize'];
}

/**
 * Keep the newest messages that fit. Both limits apply when both are set — whichever cuts more wins.
 * Neither set is a policy that keeps everything, which is what an unconfigured loop already does.
 *
 * A naive slice is safe here because a tool exchange is ONE message: the loop persists a call's
 * results onto the same assistant message that made them (`toolCalls` + `toolResults`), and each
 * model adapter expands that into the assistant/tool pair the provider wants. So a cut can't orphan
 * a tool result from its call, the way it could against a provider-shaped transcript.
 */
export function windowHistory(options: WindowHistoryOptions): HistoryPolicy {
  const estimate = options.estimate ?? estimateMessageTokens;
  const policy: HistoryPolicy = {
    select(messages: ModelMessage[]): HistorySelection {
      let cut = 0;
      if (options.maxMessages !== undefined) {
        cut = Math.max(cut, messages.length - options.maxMessages);
      }
      if (options.maxTokens !== undefined) {
        cut = Math.max(cut, tokenCut(messages, options.maxTokens, estimate));
      }
      // The newest message always rides, whatever the limits say — a turn with nothing to answer is
      // worse than a turn slightly over budget.
      cut = Math.min(cut, Math.max(0, messages.length - 1));
      return { keep: messages.slice(cut), drop: messages.slice(0, cut) };
    },
  };
  return options.summarize !== undefined ? { ...policy, summarize: options.summarize } : policy;
}

/** Index of the oldest message that still fits `maxTokens`, walking newest-first. */
function tokenCut(
  messages: ModelMessage[],
  maxTokens: number,
  estimate: (message: ModelMessage) => number,
): number {
  let index = messages.length;
  let total = 0;
  while (index > 0) {
    const message = messages[index - 1];
    if (message === undefined) {
      break;
    }
    const cost = estimate(message);
    if (index < messages.length && total + cost > maxTokens) {
      break;
    }
    total += cost;
    index -= 1;
  }
  return index;
}

/**
 * What a summarizer is told to produce when none is supplied. Written for a reader who will continue
 * the conversation without seeing the messages themselves, so it asks for the parts a later turn
 * still has to act on rather than a readable recap.
 */
export const DEFAULT_HISTORY_SUMMARY_INSTRUCTION =
  'Summarize this conversation for an assistant that will continue it without seeing these messages. Preserve decisions made, facts and constraints the user stated, identifiers and names mentioned, and anything left unresolved. Omit pleasantries. Reply with the summary only — no preamble, no headings.';

/**
 * A {@link HistoryPolicy.summarize} backed by one extra, non-streamed model call — what
 * `AgentModule.forRoot({ history: { summarize: true } })` binds. Writes to a discarding sink so the
 * summary's tokens never reach the user's live stream, and reports its usage so the call lands in
 * the spend read-model like any other.
 */
export function summarizeWithModel(
  model: ModelProvider,
  instruction: string = DEFAULT_HISTORY_SUMMARY_INSTRUCTION,
): NonNullable<HistoryPolicy['summarize']> {
  return async (dropped: ModelMessage[]): Promise<HistorySummary> => {
    const discard: SinkWriter = { write: () => {}, end: () => {}, fail: () => {} };
    const turn = await model.runTurn({
      system: instruction,
      messages: dropped,
      tools: [],
      sink: discard,
    });
    return {
      text: turn.text,
      usage: turn.usage,
      ...(turn.modelId !== undefined ? { modelId: turn.modelId } : {}),
    };
  };
}
