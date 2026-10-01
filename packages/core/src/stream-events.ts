/**
 * The structured live-stream vocabulary carried over the {@link SinkWriter} byte channel.
 *
 * The model turn (via the AI-SDK adapter) and the agent loop write these events as NDJSON — one
 * `JSON.stringify(event)\n` per {@link SinkWriter.write}. The HTTP layer forwards each line as an
 * SSE `data:` frame, and the client transport maps them back to the AI SDK UI-message chunk
 * protocol so the browser renders text, reasoning, and tool cards (input + output) LIVE — the same
 * rich rendering a raw `streamText().toUIMessageStream()` would give, but reconstructed on the
 * client so the sink stays a format-agnostic byte buffer (durable buffering/replay is untouched).
 *
 * Keeping this vocabulary neutral (not AI-SDK `UIMessageChunk`) means core never depends on `ai`:
 * the adapter owns model-parts → event, the transport owns event → UI-chunk.
 *
 * The vocabulary is also a CONTRACT for runners that are not this library's loop: anything that
 * writes these frames (one JSON object per SSE `data:` line) gets the React transport, transcript
 * model and hooks for free. Two rules keep it evolvable:
 *  - every frame is a JSON object with a string `kind`; a reader MUST tolerate kinds it does not
 *    know (the React transport forwards them as `data-<kind>` parts rather than dropping them);
 *  - fields are only ever added, and new fields are optional.
 */
import type { ElicitationRequest } from './elicitation.js';
import type { ChatQueueState } from './spi/chat-queue.js';
import type { MessageUsage } from './types.js';

/**
 * A component the server pushed into the conversation: generative UI that is NOT a tool call's
 * rendering. It is addressed by `component` (a key in the client's own component registry), never
 * by a tool name, so a runner can emit one from anywhere — a tool body, a post-processing step, a
 * sandboxed agent that renders through its own protocol.
 *
 * `id` is the component's identity within the message: a second frame with the same `id` REPLACES
 * the first (streaming props into a chart, flipping a card from "loading" to "ready"), it never
 * adds a second component.
 */
export interface AgentUiComponent {
  id: string;
  /** Registry key the client resolves to its own renderer, e.g. `data-table`. */
  component: string;
  props: Record<string, unknown>;
  /** Schema version of `props`, so a client can keep rendering components persisted by an older server. */
  version?: number;
  /**
   * The tool call that pushed the component (`ctx.emitUi`), when one did. Lets a client place it
   * with that call — a reloaded message puts it right after the call's tool part, where the live
   * stream showed it. Absent for a component pushed outside a tool.
   */
  toolCallId?: string;
}

/**
 * Who has to settle an action tool call, and until when. Metadata only: the call itself is still
 * settled through the tool-call approve/reject routes, by its `toolCallId`.
 */
export interface AgentApprovalRequest {
  /** The tool call awaiting the decision — the `id` of a call already announced on this stream. */
  id: string;
  /**
   * Who may decide. Open vocabulary the host defines — `'requester'` (the person chatting),
   * `'admin'`, a role name, a team. A client uses it to say "waiting on an admin" instead of
   * offering buttons the viewer cannot use.
   */
  approver: string;
  /** ISO-8601 instant after which the request lapses. Absent → it never expires. */
  expiresAt?: string;
  /** Why this call needs a person, in words for that person. */
  reason?: string;
}

/**
 * How an approval settled — the other half of {@link AgentApprovalRequest}, under the same `id`.
 * Metadata again: the call's own outcome still arrives as `tool-output` (approved and ran),
 * `tool-output-error` (approved and failed) or `tool-output-denied` (rejected or expired).
 */
export interface AgentApprovalSettlement {
  id: string;
  status: 'approved' | 'rejected' | 'expired';
  /** Repeated from the request, for a call approved without one being streamed (a remembered approval). */
  approver?: string;
  /** Opaque ref of who decided. Absent on an expiry. */
  decidedBy?: string;
  /** The surface the decision came through: `'web'`, `'slack'`, `'remembered'`, … */
  decidedVia?: string;
  /** The approval also covers later calls of this tool in this thread. */
  remember?: boolean;
  /** What the person said when declining. */
  reason?: string;
}

export type AgentStreamEvent =
  | { kind: 'step-start' }
  /**
   * Closes the step opened by the matching `step-start`. Carries the model call's token usage and
   * `costUsd` (an estimate from the bound pricing store, or `null` when unpriced/unbound — never a
   * fabricated `0`) so a live client can render running cost without waiting for a thread re-fetch.
   */
  | {
      kind: 'step-finish';
      usage?: MessageUsage;
      costUsd?: number | null;
      /**
       * How long the model spent thinking in this step, in ms — the same number persisted as
       * `StoredMessage.reasoningMs`, so a live thread and a reloaded one read the same duration.
       * Absent when the step had no reasoning.
       */
      reasoningMs?: number;
      /**
       * The model the step ran on: the one the provider reported, else the configured `modelId`.
       * What a per-model usage report keys on (the AG-UI producer's `RUN_FINISHED.usage`). Absent
       * when neither is known; a reader that does not know the field ignores it.
       */
      model?: string;
    }
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  /**
   * `toolKind` collapses `ToolKind`'s `'agent'` into `'read'` — delegation tools auto-execute like a read tool.
   *
   * `parentId` nests this call under another call on the same stream: the inner calls a code-mode
   * `execute` makes, the tools a delegated sub-agent runs. The parent must be announced first. A
   * call's parent is fixed by its first frame that names one; later frames may omit it.
   */
  | {
      kind: 'tool-input-start';
      id: string;
      name: string;
      toolKind: 'read' | 'action';
      parentId?: string;
    }
  | { kind: 'tool-input-delta'; id: string; delta: string }
  | {
      kind: 'tool-input-available';
      id: string;
      name: string;
      input: unknown;
      toolKind: 'read' | 'action';
      /** Same as on `tool-input-start`, for a runner that announces a call without streaming its input. */
      parentId?: string;
    }
  | { kind: 'tool-output'; id: string; output: unknown }
  | { kind: 'tool-output-error'; id: string; error: string }
  /**
   * A person was asked to approve an action tool and declined it. Its own frame, NOT
   * `tool-output-error`: a refusal is a decision with a known outcome — nothing ran — while a
   * failure is an outcome nobody chose and whose effects are unknown. Rendering them the same way
   * tells an operator their own "no" was a malfunction. Maps onto the SDK's `output-denied` tool
   * part state, which a client reads without knowing any tool's name.
   */
  | { kind: 'tool-output-denied'; id: string; reason?: string }
  /**
   * The run has put a question set to the user and is parked until someone answers it (or skips).
   * Written by the LOOP for both elicitation surfaces — the configured intake and the model's `ask`
   * tool — so a client renders one form either way rather than learning to recognise a tool name.
   * The matching `tool-output` frame, under the same `id`, carries the settled answers.
   */
  | { kind: 'elicitation'; id: string; request: ElicitationRequest }
  /**
   * An action tool call (already announced by `tool-input-start`/`tool-input-available` under the
   * same `id`) is parked on a person. Optional: a client still treats an `action` call stuck at
   * its input as pending — this frame adds WHO has to decide and UNTIL WHEN, and moves the call
   * into the AI SDK's native `approval-requested` state.
   */
  | ({ kind: 'approval-requested' } & AgentApprovalRequest)
  /**
   * A parked action call was decided (or lapsed). Optional, like `approval-requested`: it adds WHO
   * decided, THROUGH WHAT and whether the approval is REMEMBERED; the outcome itself rides the
   * call's own output frame. See {@link AgentApprovalSettlement}.
   */
  | ({ kind: 'approval-settled' } & AgentApprovalSettlement)
  /**
   * Server-pushed generative UI, positioned in the message where it arrives. Not tied to a tool
   * call. See {@link AgentUiComponent}.
   */
  | ({ kind: 'ui' } & AgentUiComponent)
  /**
   * The thread's title was set or changed while this run streamed (typically derived from the
   * first exchange). Thread-level, not message content: a client updates its header/sidebar and
   * does not render it in the transcript.
   */
  | { kind: 'title'; title: string }
  /**
   * Host-defined facts about the message being streamed (the model that answered, how long it took,
   * the error it ended with), merged into the client message's `metadata`. The persisted
   * counterpart is `StoredMessage.metadata`, so a reload reads the same values. The library's own
   * loop never writes it; a runner that is not this library's loop uses it for what its store keeps
   * per message.
   */
  | { kind: 'message-metadata'; metadata: Record<string, unknown> }
  /**
   * Someone stopped this run. The stream's LAST frame, written by the runner that settled the
   * cancel, immediately before a normal `end()` — never a `fail()`, because a cancel is not an
   * error and a client that retries on a failed stream must not retry this.
   *
   * A run that simply ends wrote everything it had; one that ends after this frame did not, and the
   * difference is the whole point: without it a reader cannot tell a truncated answer from a
   * complete one. Consumers that predate the frame ignore it and see the `end()` they always saw.
   */
  | { kind: 'cancelled' }
  /**
   * The thread's message queue changed — a snapshot of the whole queue, never a delta, so a client
   * that missed one frame is corrected by the next. Written into the stream of the run that is
   * holding the thread: when someone queues, edits, reorders or removes a waiting message, and, just
   * before this run's own terminal frame, with what happens next — `started` names the queued
   * message that became the next turn and that turn's run id (attach to it with
   * `GET <base>/chat/:runId/stream`), `queue.paused` says why nothing starts.
   */
  | { kind: 'queue'; queue: ChatQueueState; started?: { messageId: string; runId: string } };

const encoder = new TextEncoder();

/** Encode one event as an NDJSON line (`{...}\n`) for {@link SinkWriter.write}. */
export function encodeStreamEvent(event: AgentStreamEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`);
}

/**
 * Read one NDJSON line back, or `null` when the line is not a stream event at all.
 *
 * `null` covers a genuinely opaque chunk, not just malformed JSON: the sink is a byte channel, so a
 * model provider is free to write anything into it and some write bare text. A caller that has to
 * CLASSIFY a chunk — the output gate, which may only forward what it can prove is not the answer —
 * treats an unreadable frame as unclassifiable rather than guessing.
 */
export function decodeStreamEvent(line: string): AgentStreamEvent | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as AgentStreamEvent).kind === 'string'
    ) {
      return parsed as AgentStreamEvent;
    }
  } catch {
    /* not a stream event — the caller decides what an opaque chunk means */
  }
  return null;
}

/**
 * The `code` of a failed run's `event: error` frame — what a client branches on, and translates.
 * `quota_exceeded`, `output_rejected` and `structured_output_invalid` are outcomes the library words
 * itself (their `message` is safe to show as it is); the rest are crashes, whose `message` is a
 * generic sentence in production. Open-ended on purpose: a host's own runner may send other codes.
 */
export type AgentStreamErrorCode =
  | 'quota_exceeded'
  | 'output_rejected'
  | 'structured_output_invalid'
  /** The durable runtime refused a checkpoint position: the run's journal and its code disagree. */
  | 'replay_diverged'
  /** A model call ended without producing anything. */
  | 'model_no_output'
  | 'run_failed';
