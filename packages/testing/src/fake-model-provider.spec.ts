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
