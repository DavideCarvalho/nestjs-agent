import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGuardrails } from './guardrails/index.js';
import { Vault } from './guardrails/vault.js';
import { createFrameBuffer, createIncrementalGate, releaseGatedFrames } from './processors.js';
import type { OutputProcessor, ProcessorContext } from './spi/processors.js';
import type { SinkWriter } from './spi/token-stream-sink.js';
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

describe('createIncrementalGate', () => {
  const ctx: ProcessorContext = { threadId: 't1', actor: { id: 'u1', roles: [] }, step: 0 };

  function recorder(): { writer: SinkWriter; text: () => string } {
    let text = '';
    return {
      writer: {
        write: (chunk) => {
          const event = decodeStreamEvent(decoder.decode(chunk).trimEnd());
          if (event?.kind === 'text') text += event.text;
        },
        end: () => {},
        fail: () => {},
      },
      text: () => text,
    };
  }

  async function stream(gate: { writer: SinkWriter }, tokens: number): Promise<string> {
    let answer = '';
    for (let i = 0; i < tokens; i++) {
      const token = `w${i} `;
      answer += token;
      await gate.writer.write(encodeStreamEvent({ kind: 'text', text: token }));
    }
    return answer;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rules on the growing prefix once per half window, not once per token', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const seen: number[] = [];
    const counting: OutputProcessor = {
      name: 'counting',
      incremental: { lookbackChars: 256 },
      process: (answer) => {
        seen.push(answer.text.length);
        return { action: 'pass' };
      },
    };
    const out = recorder();
    const gate = createIncrementalGate({
      processors: [counting],
      ctx,
      lookbackChars: 256,
      writer: out.writer,
    });
    const answer = await stream(gate, 2_000);
    await gate.settled();
    // ~12k characters at one pass per 128 of them, plus the pass `settled` runs on the rest.
    expect(seen.length).toBeLessThan(120);
    expect(seen.at(-1)).toBe(answer.length);
    // What is out by the time the gate settles is the same as a pass per token would have released.
    expect(out.text()).toBe(answer.slice(0, answer.length - 256));
    expect(gate.released()).toBe(out.text());
  });

  it('still releases a slow stream between half windows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let passes = 0;
    const counting: OutputProcessor = {
      name: 'counting',
      incremental: { lookbackChars: 256 },
      process: () => {
        passes += 1;
        return { action: 'pass' };
      },
    };
    const gate = createIncrementalGate({
      processors: [counting],
      ctx,
      lookbackChars: 256,
      writer: recorder().writer,
    });
    await gate.writer.write(encodeStreamEvent({ kind: 'text', text: 'a' }));
    expect(passes).toBe(0);
    vi.advanceTimersByTime(300);
    await gate.writer.write(encodeStreamEvent({ kind: 'text', text: 'b' }));
    expect(passes).toBe(1);
  });

  it("loads the thread's vault once per gate rather than once per prefix", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let loads = 0;
    const guardrails = createGuardrails({
      pii: 'redact',
      vaults: {
        load: () => {
          loads += 1;
          return new Vault();
        },
        save: () => {},
      },
    });
    const gate = createIncrementalGate({
      processors: [guardrails.output],
      ctx,
      lookbackChars: 256,
      writer: recorder().writer,
    });
    await stream(gate, 500);
    await gate.settled();
    expect(loads).toBe(1);
  });
});
