import type { SinkWriter } from './spi/token-stream-sink.js';

const decoder = new TextDecoder();

/** The writer {@link observeFirstText} hands back, and the instant it saw the turn's first text. */
export interface FirstTextObserver {
  writer: SinkWriter;
  /** When the first non-empty `text` frame went through the writer; `undefined` until one has. */
  firstTextAt(): number | undefined;
}

/**
 * Wraps the turn's stream writer to note when the first non-empty `text` frame is written — the
 * moment the person reading the stream sees the answer begin, so a frame an output gate held back
 * counts when it was RELEASED, not when the model produced it. Frames are only decoded until the
 * first text has been seen, and only when they could be a `text` frame.
 *
 * The instant is this process's clock. A replayed checkpoint writes nothing, so the loop journals
 * what it read here with the checkpoint that did the writing — see `runAgentLoop`.
 */
export function observeFirstText(
  writer: SinkWriter,
  now: () => number = Date.now,
): FirstTextObserver {
  let seenAt: number | undefined;
  const note = (chunk: Uint8Array) => {
    const text = decoder.decode(chunk);
    if (!text.includes('"kind":"text"')) return;
    for (const line of text.split('\n')) {
      if (!line.includes('"kind":"text"')) continue;
      let event: { kind?: unknown; text?: unknown };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        continue;
      }
      if (event.kind === 'text' && typeof event.text === 'string' && event.text.length > 0) {
        seenAt = now();
        return;
      }
    }
  };
  const wrapped: SinkWriter = Object.create(writer) as SinkWriter;
  wrapped.write = (chunk: Uint8Array) => {
    if (seenAt === undefined) {
      try {
        note(chunk);
      } catch {
        // Telemetry never stands in the stream's way.
      }
    }
    return writer.write(chunk);
  };
  wrapped.end = () => writer.end();
  wrapped.fail = (error) => writer.fail(error);
  if (typeof writer.flush === 'function') {
    wrapped.flush = () => (writer.flush as () => void | Promise<void>).call(writer);
  }
  return { writer: wrapped, firstTextAt: () => seenAt };
}
