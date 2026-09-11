import { describe, expect, it } from 'vitest';
import { createFrameBuffer, releaseGatedFrames } from './processors.js';
import { decodeStreamEvent, encodeStreamEvent } from './stream-events.js';

const decoder = new TextDecoder();

function released(frames: string[], text: string): unknown[] {
  return releaseGatedFrames(frames, text).map((chunk): unknown =>
    JSON.parse(decoder.decode(chunk)),
  );
}

function line(event: Parameters<typeof encodeStreamEvent>[0]): string {
  return JSON.stringify(event);
}

describe('createFrameBuffer', () => {
  it('keeps every NDJSON line in write order, splitting a chunk that carries several', () => {
    const buffer = createFrameBuffer();
    buffer.writer.write(encodeStreamEvent({ kind: 'text', text: 'a' }));
    buffer.writer.write(
      new TextEncoder().encode(
        `${line({ kind: 'text', text: 'b' })}\n${line({ kind: 'step-finish' })}\n`,
      ),
    );
    expect(buffer.frames()).toEqual([
      line({ kind: 'text', text: 'a' }),
      line({ kind: 'text', text: 'b' }),
      line({ kind: 'step-finish' }),
    ]);
  });
});

describe('releaseGatedFrames', () => {
  it('puts the gated answer where the model’s first text frame was, keeping the rest in order', () => {
    const frames = [
      line({ kind: 'reasoning', text: 'thinking' }),
      line({ kind: 'text', text: 'the ' }),
      line({ kind: 'text', text: 'secret' }),
      line({ kind: 'tool-input-available', id: 'c1', name: 'peek', input: {}, toolKind: 'read' }),
    ];
    expect(released(frames, 'the [redacted]')).toEqual([
      { kind: 'reasoning', text: 'thinking' },
      { kind: 'text', text: 'the [redacted]' },
      { kind: 'tool-input-available', id: 'c1', name: 'peek', input: {}, toolKind: 'read' },
    ]);
  });

  it('drops a frame it cannot classify rather than forwarding it', () => {
    // Valid JSON, but not the stream vocabulary — a gate that forwards what it cannot read is not a
    // gate, so this must never reach the subscriber even though it parses.
    const frames = [
      '"the secret is 42"',
      JSON.stringify({ text: 'the secret is 42' }),
      'the secret is 42',
    ];
    expect(released(frames, 'nothing to see')).toEqual([{ kind: 'text', text: 'nothing to see' }]);
  });

  it('still emits the answer for a model that streamed no text frames at all', () => {
    expect(released([line({ kind: 'step-finish' })], 'the answer')).toEqual([
      { kind: 'step-finish' },
      { kind: 'text', text: 'the answer' },
    ]);
  });

  it('emits no text frame when the gate left nothing to say', () => {
    expect(released([line({ kind: 'text', text: 'gone' })], '')).toEqual([]);
  });
});

describe('decodeStreamEvent', () => {
  it('reads a stream event back, and reports anything else as unclassifiable', () => {
    expect(decodeStreamEvent(line({ kind: 'text', text: 'hi' }))).toEqual({
      kind: 'text',
      text: 'hi',
    });
    expect(decodeStreamEvent('not json')).toBeNull();
    expect(decodeStreamEvent('42')).toBeNull();
    expect(decodeStreamEvent(JSON.stringify({ kind: 7 }))).toBeNull();
  });
});
