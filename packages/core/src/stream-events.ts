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
  | { kind: 'tool-output-error'; id: string; error: string };

const encoder = new TextEncoder();

/** Encode one event as an NDJSON line (`{...}\n`) for {@link SinkWriter.write}. */
export function encodeStreamEvent(event: AgentStreamEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`);
}
