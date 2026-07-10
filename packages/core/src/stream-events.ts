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
export type AgentStreamEvent =
  | { kind: 'step-start' }
  | { kind: 'step-finish' }
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool-input-start'; id: string; name: string }
  | { kind: 'tool-input-delta'; id: string; delta: string }
  | { kind: 'tool-input-available'; id: string; name: string; input: unknown }
  | { kind: 'tool-output'; id: string; output: unknown }
  | { kind: 'tool-output-error'; id: string; error: string };

const encoder = new TextEncoder();

/** Encode one event as an NDJSON line (`{...}\n`) for {@link SinkWriter.write}. */
export function encodeStreamEvent(event: AgentStreamEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`);
}
