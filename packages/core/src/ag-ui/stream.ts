import { AgentStreamError } from '../spi/token-stream-sink.js';
import { decodeStreamEvent } from '../stream-events.js';
import { AgUiEncoder, type AgUiEncoderOptions } from './encoder.js';
import type { AgUiEvent, AgUiSourceFrame } from './types.js';

export interface AgUiStreamOptions extends AgUiEncoderOptions {
  /**
   * How long the library stream may stay silent, while the run waits on a person AND has other work
   * announced, before the AG-UI run is reported interrupted. Default 750 ms.
   *
   * Only that mixed case needs a clock. A run whose every open tool call is waiting on someone is
   * reported at once; a run waiting on no one is never cut short.
   */
  quietMs?: number;
  /** Events to write right after `RUN_STARTED` (warnings about input that was dropped). */
  preamble?: AgUiEvent[];
}

const DEFAULT_QUIET_MS = 750;
const GRACE_MS = 50;

type Next = IteratorResult<AgUiSourceFrame> | 'quiet';

/**
 * One AG-UI run over a library run's stream.
 *
 * AG-UI has no mid-run channel from the consumer: a run that needs an approval or an answer does not
 * wait with the connection open — it ENDS, saying what it waits for, and a later run carries the
 * answers. The library run underneath does wait (parked, durably when the runner is durable). So this
 * stops reading when the run is waiting on someone and nothing else is moving, closes the AG-UI run
 * with the interrupt outcome, and leaves the library run parked for the resume to pick up.
 */
export async function* agUiEvents(
  frames: AsyncIterable<AgUiSourceFrame>,
  options: AgUiStreamOptions,
): AsyncGenerator<AgUiEvent> {
  const encoder = new AgUiEncoder(options);
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  yield* encoder.start();
  yield* options.preamble ?? [];
  const iterator = frames[Symbol.asyncIterator]();
  let upcoming: Promise<IteratorResult<AgUiSourceFrame>> | undefined;
  let ended = false;
  try {
    for (;;) {
      upcoming ??= iterator.next();
      // Frames buffered before this reader attached are replayed without a pause between them, so
      // "is it waiting?" is only asked of a stream that has caught up with what it already holds.
      const caughtUp = encoder.consumed >= (options.skip ?? 0);
      let next: Next;
      if (caughtUp && encoder.waiting) {
        // Nothing else in flight: only a frame already on its way (a sink that reads in batches)
        // can still arrive, so a short grace is enough. Otherwise wait out the quiet window.
        next = await raceQuiet(upcoming, encoder.busy ? quietMs : Math.min(quietMs, GRACE_MS));
      } else {
        next = await upcoming;
      }
      if (next === 'quiet') break;
      upcoming = undefined;
      if (next.done === true) {
        ended = true;
        break;
      }
      yield* encoder.encode(next.value);
    }
  } finally {
    // Stop following the library stream; the run it carries is left exactly as it is.
    void iterator.return?.();
  }
  yield* encoder.finish(ended);
}

function raceQuiet(upcoming: Promise<IteratorResult<AgUiSourceFrame>>, ms: number): Promise<Next> {
  return new Promise<Next>((resolve, reject) => {
    const timer = setTimeout(() => resolve('quiet'), ms);
    upcoming.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** One AG-UI event as an SSE frame: a single `data:` line, LF-terminated, as the binding pins. */
export function agUiSse(event: AgUiEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * A byte sink's stream (NDJSON {@link AgentStreamEvent}s, one per line, as the NestJS sinks carry
 * it) as the frames the encoder reads. A line that is not a stream event is bare model text — the
 * sink is a byte channel and a provider may write raw text into it. A run that failed ends the
 * sink with an {@link AgentStreamError}, which becomes the terminal `error` frame; anything else
 * thrown is rethrown, for the caller to report.
 */
export async function* agUiFramesFromNdjson(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<AgUiSourceFrame> {
  const decoder = new TextDecoder();
  let buffer = '';
  // Bare text has no line end of its own, so the event written after it shares its line.
  const read = (line: string): AgUiSourceFrame[] => {
    const event = decodeStreamEvent(line) as AgUiSourceFrame | null;
    if (event !== null) return [event];
    const at = line.indexOf('{"kind":');
    const tail = at > 0 ? (decodeStreamEvent(line.slice(at)) as AgUiSourceFrame | null) : null;
    if (tail !== null) return [{ kind: 'text', text: line.slice(0, at) }, tail];
    return [{ kind: 'text', text: line }];
  };
  try {
    for await (const chunk of chunks) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) yield* read(line);
        newline = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) yield* read(buffer);
  } catch (error) {
    if (error instanceof AgentStreamError) {
      yield { kind: 'error', code: error.code, message: error.message };
      return;
    }
    throw error;
  }
}
