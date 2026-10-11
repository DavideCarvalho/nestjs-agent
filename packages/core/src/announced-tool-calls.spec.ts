import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { announcedToolCalls } from './announced-tool-calls.js';
import type { SinkWriter } from './spi/token-stream-sink.js';
import { encodeStreamEvent } from './stream-events.js';

function recording() {
  const lines: string[] = [];
  const decoder = new TextDecoder();
  const writer: SinkWriter = {
    write: (chunk) => {
      lines.push(decoder.decode(chunk));
    },
    end: () => {},
    fail: () => {},
  };
  return { writer, lines };
}

describe('announcedToolCalls', () => {
  it('announces only the calls the provider did not stream, with their kind', async () => {
    const inner = recording();
    const announced = announcedToolCalls(inner.writer);
    await announced.writer.write(new TextEncoder().encode('Let me check'));
    await announced.writer.write(
      encodeStreamEvent({ kind: 'tool-input-start', id: 'c1', name: 'lookup', toolKind: 'read' }),
    );
    const tools = [
      { name: 'lookup', kind: 'read' as const, description: '', inputSchema: z.object({}) },
      { name: 'refund', kind: 'action' as const, description: '', inputSchema: z.object({}) },
    ];
    await announced.announceRest(
      [
        { id: 'c1', name: 'lookup', input: {} },
        { id: 'c2', name: 'refund', input: { id: 'A-1' } },
      ],
      tools,
    );
    await announced.announceRest([{ id: 'c2', name: 'refund', input: { id: 'A-1' } }], tools);
    const announcedLines = inner.lines.filter((line) => line.includes('tool-input-available'));
    expect(announcedLines.map((line) => JSON.parse(line))).toEqual([
      {
        kind: 'tool-input-available',
        id: 'c2',
        name: 'refund',
        input: { id: 'A-1' },
        toolKind: 'action',
      },
    ]);
  });
});
