import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { type AnyToolUIPart, buildTranscriptBlocks, describeUsage } from './model.js';

const openAll = {
  isReasoningOpen: (_key: string, isStreaming: boolean) => isStreaming,
  toggleReasoning: () => undefined,
};

function file(url: string, mediaType: string, filename?: string): UIMessage['parts'][number] {
  return { type: 'file', url, mediaType, ...(filename ? { filename } : {}) };
}

function tool(id: string): AnyToolUIPart {
  return {
    type: 'tool-search',
    toolCallId: id,
    state: 'output-available',
    input: {},
    output: {},
  } as AnyToolUIPart;
}

function message(parts: UIMessage['parts'], id = 'm1'): UIMessage {
  return { id, role: 'user', parts };
}

describe('buildTranscriptBlocks — files', () => {
  it('models a file part instead of dropping it', () => {
    // An attachment is content the user put on the message. Skipping it leaves the turn reading as
    // if nothing was sent but the prose.
    const blocks = buildTranscriptBlocks(
      message([file('https://s3/a.png', 'image/png', 'a.png')]),
      openAll,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'files',
      files: [
        { url: 'https://s3/a.png', mediaType: 'image/png', filename: 'a.png', isImage: true },
      ],
    });
  });

  it('marks a non-image so a renderer can link it rather than try to show it', () => {
    const blocks = buildTranscriptBlocks(
      message([file('https://s3/spec.pdf', 'application/pdf')]),
      openAll,
    );
    expect(blocks[0]).toMatchObject({
      kind: 'files',
      files: [{ isImage: false, filename: null }],
    });
  });

  it('groups consecutive files into one strip', () => {
    const blocks = buildTranscriptBlocks(
      message([file('https://s3/a.png', 'image/png'), file('https://s3/b.png', 'image/png')]),
      openAll,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind === 'files' && blocks[0].files).toHaveLength(2);
  });

  it('keeps files and tool calls in the order they arrived', () => {
    // Position is meaning: a file the user attached before asking reads differently from one the
    // run produced after searching.
    const blocks = buildTranscriptBlocks(
      message([file('https://s3/a.png', 'image/png'), tool('t1')]),
      openAll,
    );
    expect(blocks.map((block) => block.kind)).toEqual(['files', 'tools']);

    const reversed = buildTranscriptBlocks(
      message([tool('t1'), file('https://s3/a.png', 'image/png')]),
      openAll,
    );
    expect(reversed.map((block) => block.kind)).toEqual(['tools', 'files']);
  });
});

describe('describeUsage — unpriced turns', () => {
  it('says nothing rather than $0 when no price is on record', () => {
    // `null` and `0` are different facts: one is a turn that cost nothing, the other is a turn
    // whose cost the store never knew. Printing `$0` for the second states a number nobody has.
    expect(describeUsage({ inputTokens: 1000, outputTokens: 500, costUsd: null }).costLabel).toBe(
      '—',
    );
    expect(describeUsage({ inputTokens: 1000, outputTokens: 500, costUsd: 0 }).costLabel).toBe(
      '$0',
    );
  });
});
