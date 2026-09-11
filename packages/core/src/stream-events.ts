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
 */
import type { ElicitationRequest } from './elicitation.js';
import type { MessageUsage } from './types.js';

export type AgentStreamEvent =
  | { kind: 'step-start' }
  /**
   * Closes the step opened by the matching `step-start`. Carries the model call's token usage and
   * `costUsd` (an estimate from the bound pricing store, or `null` when unpriced/unbound — never a
   * fabricated `0`) so a live client can render running cost without waiting for a thread re-fetch.
   */
  | { kind: 'step-finish'; usage?: MessageUsage; costUsd?: number | null }
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  /** `toolKind` collapses `ToolKind`'s `'agent'` into `'read'` — delegation tools auto-execute like a read tool. */
  | { kind: 'tool-input-start'; id: string; name: string; toolKind: 'read' | 'action' }
  | { kind: 'tool-input-delta'; id: string; delta: string }
  | {
      kind: 'tool-input-available';
      id: string;
      name: string;
      input: unknown;
      toolKind: 'read' | 'action';
    }
  | { kind: 'tool-output'; id: string; output: unknown }
  | { kind: 'tool-output-error'; id: string; error: string }
  /**
   * The run has put a question set to the user and is parked until someone answers it (or skips).
   * Written by the LOOP for both elicitation surfaces — the configured intake and the model's `ask`
   * tool — so a client renders one form either way rather than learning to recognise a tool name.
   * The matching `tool-output` frame, under the same `id`, carries the settled answers.
   */
  | { kind: 'elicitation'; id: string; request: ElicitationRequest }
  /**
   * Someone stopped this run. The stream's LAST frame, written by the runner that settled the
   * cancel, immediately before a normal `end()` — never a `fail()`, because a cancel is not an
   * error and a client that retries on a failed stream must not retry this.
   *
   * A run that simply ends wrote everything it had; one that ends after this frame did not, and the
   * difference is the whole point: without it a reader cannot tell a truncated answer from a
   * complete one. Consumers that predate the frame ignore it and see the `end()` they always saw.
   */
  | { kind: 'cancelled' };

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
