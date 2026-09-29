import { describe, expect, it } from 'vitest';
import { storedMessageToUiMessage } from './stored-message-to-ui-message.js';
import { buildTranscriptBlocks } from './transcript/model.js';

describe('storedMessageToUiMessage — reasoning and pushed UI', () => {
  const message = storedMessageToUiMessage({
    id: 'm1',
    role: 'assistant',
    content: 'Seven.',
    reasoning: 'Counting rows…',
    reasoningMs: 2_400,
    ui: [{ id: 'u1', component: 'stat', props: { value: 7 }, version: 1 }],
    createdAt: '2026-09-29T00:00:00.000Z',
  });

  it('puts the reasoning before the text and the components after it', () => {
    expect(message.parts).toEqual([
      {
        type: 'reasoning',
        text: 'Counting rows…',
        state: 'done',
        providerMetadata: { agent: { reasoningMs: 2_400 } },
      },
      { type: 'text', text: 'Seven.' },
      {
        type: 'data-ui',
        id: 'u1',
        data: { id: 'u1', component: 'stat', props: { value: 7 }, version: 1 },
      },
    ]);
  });

  it('reloads into the same blocks a live stream builds, duration included', () => {
    const blocks = buildTranscriptBlocks(message, {
      isReasoningOpen: () => false,
      toggleReasoning: () => undefined,
    });
    expect(blocks.map((block) => block.kind)).toEqual(['reasoning', 'text', 'ui']);
    expect(blocks[0]).toMatchObject({ kind: 'reasoning', durationMs: 2_400, isStreaming: false });
  });

  it('adds nothing for a message that recorded neither', () => {
    expect(
      storedMessageToUiMessage({
        id: 'm2',
        role: 'assistant',
        content: 'hi',
        createdAt: '2026-09-29T00:00:00.000Z',
      }).parts,
    ).toEqual([{ type: 'text', text: 'hi' }]);
  });
});
