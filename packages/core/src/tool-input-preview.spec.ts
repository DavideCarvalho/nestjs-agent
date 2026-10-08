import { describe, expect, it } from 'vitest';
import type { SinkWriter } from './spi/token-stream-sink.js';
import type { ToolInputPreview } from './spi/tool.js';
import { type AgentStreamEvent, decodeStreamEvent, encodeStreamEvent } from './stream-events.js';
import { previewToolInputs, registryInputPreviews } from './tool-input-preview.js';

function recorder() {
  const events: AgentStreamEvent[] = [];
  const writer: SinkWriter = {
    write(chunk) {
      for (const line of new TextDecoder().decode(chunk).split('\n')) {
        const event = line.length > 0 ? decodeStreamEvent(line) : null;
        if (event !== null) events.push(event);
      }
    },
    end() {},
    fail() {},
  };
  return { events, writer };
}

const echo: ToolInputPreview = {
  render: (input) => ({ component: 'Echo', props: { value: input.value ?? null } }),
};
const start = (id = 'c1', name = 'echo') =>
  encodeStreamEvent({ kind: 'tool-input-start', id, name, toolKind: 'read' });
const delta = (text: string, id = 'c1') =>
  encodeStreamEvent({ kind: 'tool-input-delta', id, delta: text });
const available = (input: unknown, id = 'c1') =>
  encodeStreamEvent({ kind: 'tool-input-available', id, name: 'echo', input, toolKind: 'read' });
const partials = (events: AgentStreamEvent[]) =>
  events.filter(
    (event): event is Extract<AgentStreamEvent, { kind: 'ui' }> =>
      event.kind === 'ui' && event.partial === true,
  );

describe('previewToolInputs', () => {
  it('passes every frame through and adds partial ui frames under the push id', async () => {
    const { events, writer } = recorder();
    const previews = previewToolInputs(writer, async (name) =>
      name === 'echo' ? echo : undefined,
    );
    await previews.writer.write(start());
    await previews.writer.write(delta('{"a":"x'));
    await previews.writer.write(available({ a: 'xy' }));
    expect(events.map((event) => event.kind)).toEqual([
      'tool-input-start',
      'tool-input-delta',
      'ui',
      'tool-input-available',
      'ui',
    ]);
    expect(partials(events)).toEqual([
      {
        kind: 'ui',
        id: 'c1:ui:0',
        component: 'Echo',
        props: { value: { a: 'x' } },
        toolCallId: 'c1',
        partial: true,
      },
      {
        kind: 'ui',
        id: 'c1:ui:0',
        component: 'Echo',
        props: { value: { a: 'xy' } },
        toolCallId: 'c1',
        partial: true,
      },
    ]);
    expect(previews.shown()).toEqual([{ id: 'c1:ui:0', component: 'Echo', toolCallId: 'c1' }]);
  });

  it('reads frames split across writes, and several in one write', async () => {
    const { events, writer } = recorder();
    const previews = previewToolInputs(writer, async () => ({ ...echo, throttleMs: 0 }));
    const bytes = new Uint8Array([...start(), ...delta('{"a":1,')]);
    await previews.writer.write(bytes.slice(0, 10));
    await previews.writer.write(bytes.slice(10));
    expect(partials(events)).toEqual([expect.objectContaining({ props: { value: { a: 1 } } })]);
  });

  it('throttles: at most one frame per interval, the rest coalesced into the next', async () => {
    let clock = 0;
    const { events, writer } = recorder();
    const previews = previewToolInputs(
      writer,
      async () => ({ ...echo, throttleMs: 100 }),
      () => clock,
    );
    await previews.writer.write(start());
    const text = JSON.stringify({ items: Array.from({ length: 50 }, (_, index) => index) });
    // 200 deltas over 1s of model time: one every 5ms.
    const step = Math.ceil(text.length / 200);
    for (let at = 0; at < text.length; at += step) {
      clock += 5;
      await previews.writer.write(delta(text.slice(at, at + step)));
    }
    const live = partials(events).length;
    expect(live).toBeGreaterThan(1);
    expect(live).toBeLessThanOrEqual(Math.ceil(clock / 100) + 1);
    await previews.writer.write(available(JSON.parse(text)));
    expect(partials(events).at(-1)?.props).toEqual({ value: JSON.parse(text) });
  });

  it('writes nothing for an unchanged preview, nor for a call without one', async () => {
    const { events, writer } = recorder();
    const previews = previewToolInputs(writer, async (name) =>
      name === 'echo' ? { render: () => ({ component: 'Same', props: {} }) } : undefined,
    );
    await previews.writer.write(start());
    await previews.writer.write(delta('{"a'));
    await previews.writer.write(delta('":1}'));
    await previews.writer.write(available({ a: 1 }));
    expect(partials(events)).toHaveLength(1);
    await previews.writer.write(start('c2', 'other'));
    await previews.writer.write(delta('{}', 'c2'));
    expect(partials(events)).toHaveLength(1);
  });

  it('withdraws what it showed when the preview gives up, and stops', async () => {
    const { events, writer } = recorder();
    let calls = 0;
    const previews = previewToolInputs(writer, async () => ({
      throttleMs: 0,
      render: () => (calls++ === 0 ? { component: 'genui:tree', props: { root: {} } } : null),
    }));
    await previews.writer.write(start());
    await previews.writer.write(delta('{'));
    await previews.writer.write(delta('"x"'));
    await previews.writer.write(delta(':1'));
    expect(partials(events)).toEqual([
      expect.objectContaining({ props: { root: {} } }),
      expect.objectContaining({ props: {}, id: 'c1:ui:0', partial: true }),
    ]);
    expect(calls).toBe(2);
    expect(previews.shown()).toEqual([]);
  });

  it('a preview that throws is dropped, never the turn', async () => {
    const { events, writer } = recorder();
    const previews = previewToolInputs(writer, async () => ({
      render: () => {
        throw new Error('boom');
      },
    }));
    await previews.writer.write(start());
    await previews.writer.write(delta('{}'));
    expect(partials(events)).toEqual([]);
    const failing = previewToolInputs(writer, async () => {
      throw new Error('no catalog');
    });
    await failing.writer.write(start('c3'));
    await failing.writer.write(delta('{}', 'c3'));
    expect(partials(events)).toEqual([]);
  });
});

describe('registryInputPreviews', () => {
  it('asks the registry only for a tool the turn offered, with the turn scope and call id', async () => {
    const asked: unknown[] = [];
    const resolve = registryInputPreviews(
      {
        previewInput: async (name, scope) => {
          asked.push([name, scope]);
          return echo;
        },
      },
      [{ name: 'echo' }],
      { actor: { id: 'u1' }, threadId: 't1' },
    );
    expect(await resolve('echo', 'c1')).toBe(echo);
    expect(await resolve('hidden', 'c2')).toBeUndefined();
    expect(asked).toEqual([['echo', { actor: { id: 'u1' }, threadId: 't1', toolCallId: 'c1' }]]);
  });
});
