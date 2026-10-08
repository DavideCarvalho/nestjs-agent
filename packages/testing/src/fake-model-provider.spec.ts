import { type SinkWriter, decodeStreamEvent } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it } from 'vitest';
import { FakeModelProvider } from './fake-model-provider.js';

describe('FakeModelProvider', () => {
  it('streams its text as a `text` stream event, the way a real provider does', async () => {
    const chunks: Uint8Array[] = [];
    const sink: SinkWriter = { write: (chunk) => void chunks.push(chunk), end() {}, fail() {} };
    await new FakeModelProvider(() => ({ text: 'hello' })).runTurn({
      messages: [],
      sink,
    } as never);

    const lines = chunks.map((chunk) => new TextDecoder().decode(chunk).trimEnd());
    expect(lines.map(decodeStreamEvent)).toEqual([{ kind: 'text', text: 'hello' }]);
  });
});

/**
 * A tool call id is the stores' primary key across every thread (`agent_tool_call.id`), so one
 * provider serving several threads (a test app, a demo) must never hand two calls the same id.
 */
describe('FakeModelProvider tool call ids', () => {
  const sink: SinkWriter = { write() {}, end() {}, fail() {} };
  const argsAt = (turns: number) =>
    ({
      system: '',
      messages: [
        { role: 'user', content: 'hi' },
        ...Array.from({ length: turns }, () => ({ role: 'assistant', content: 'x' })),
      ],
      tools: [],
      sink,
    }) as never;

  it('keeps call-<turn>-<name> for the first call, and never repeats an id', async () => {
    const model = new FakeModelProvider(() => ({
      text: '',
      toolCalls: [
        { name: 'lookup', input: {} },
        { name: 'lookup', input: {} },
      ],
    }));
    const first = await model.runTurn(argsAt(0));
    const second = await model.runTurn(argsAt(0));
    const ids = [...first.toolCalls, ...second.toolCalls].map((call) => call.id);
    expect(ids[0]).toBe('call-0-lookup');
    expect(ids).toEqual(['call-0-lookup', 'call-0-lookup-2', 'call-0-lookup-3', 'call-0-lookup-4']);
    // A fresh provider starts over: the ids are deterministic per instance.
    const again = await new FakeModelProvider(() => ({
      text: '',
      toolCall: { name: 'lookup', input: {} },
    })).runTurn(argsAt(0));
    expect(again.toolCalls[0]?.id).toBe('call-0-lookup');
  });
});
