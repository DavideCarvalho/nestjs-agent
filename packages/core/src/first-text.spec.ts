import { describe, expect, it } from 'vitest';
import { observeFirstText } from './first-text.js';
import type { SinkWriter, StreamError } from './spi/token-stream-sink.js';
import { encodeStreamEvent } from './stream-events.js';

function recordingWriter(): {
  writer: SinkWriter;
  written: Uint8Array[];
  ended: () => boolean;
  failed: () => StreamError | undefined;
  flushed: () => number;
} {
  const written: Uint8Array[] = [];
  let ended = false;
  let failed: StreamError | undefined;
  let flushed = 0;
  return {
    writer: {
      write: (chunk) => void written.push(chunk),
      end: () => {
        ended = true;
      },
      fail: (error) => {
        failed = error;
      },
      flush: () => {
        flushed += 1;
      },
    },
    written,
    ended: () => ended,
    failed: () => failed,
    flushed: () => flushed,
  };
}

describe('observeFirstText', () => {
  it('notes the first non-empty text frame and nothing after it', async () => {
    const sink = recordingWriter();
    let clock = 100;
    const observed = observeFirstText(sink.writer, () => clock);
    expect(observed.firstTextAt()).toBeUndefined();

    await observed.writer.write(encodeStreamEvent({ kind: 'step-start' }));
    clock = 150;
    await observed.writer.write(encodeStreamEvent({ kind: 'text', text: '' }));
    expect(observed.firstTextAt()).toBeUndefined();

    clock = 200;
    await observed.writer.write(encodeStreamEvent({ kind: 'text', text: 'Hel' }));
    clock = 300;
    await observed.writer.write(encodeStreamEvent({ kind: 'text', text: 'lo' }));

    expect(observed.firstTextAt()).toBe(200);
    expect(sink.written).toHaveLength(4);
  });

  it('finds a text frame inside a chunk that carries several lines', async () => {
    const sink = recordingWriter();
    const observed = observeFirstText(sink.writer, () => 42);
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const chunk = encoder.encode(
      decoder.decode(encodeStreamEvent({ kind: 'step-start' })) +
        decoder.decode(encodeStreamEvent({ kind: 'text', text: 'hi' })),
    );
    await observed.writer.write(chunk);
    expect(observed.firstTextAt()).toBe(42);
  });

  it('ignores frames that are not text, and bytes that are not frames at all', async () => {
    const sink = recordingWriter();
    const observed = observeFirstText(sink.writer, () => 1);
    await observed.writer.write(encodeStreamEvent({ kind: 'reasoning', text: 'thinking' }));
    await observed.writer.write(new TextEncoder().encode('{"kind":"text", broken\n'));
    await observed.writer.write(new TextEncoder().encode('plain bytes'));
    expect(observed.firstTextAt()).toBeUndefined();
    expect(sink.written).toHaveLength(3);
  });

  it('passes end, fail and flush through to the wrapped writer', async () => {
    const sink = recordingWriter();
    const observed = observeFirstText(sink.writer);
    await observed.writer.flush?.();
    await observed.writer.fail({ code: 'run_failed', message: 'boom' });
    await observed.writer.end();
    expect(sink.flushed()).toBe(1);
    expect(sink.failed()).toEqual({ code: 'run_failed', message: 'boom' });
    expect(sink.ended()).toBe(true);
  });

  it('leaves flush absent when the wrapped writer has none', () => {
    const observed = observeFirstText({ write() {}, end() {}, fail() {} });
    expect(observed.writer.flush).toBeUndefined();
  });
});
