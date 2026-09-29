import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { type AnyToolUIPart, type TranscriptToolBlock, buildTranscriptBlocks } from './model.js';

const openAll = {
  isReasoningOpen: (_key: string, isStreaming: boolean) => isStreaming,
  toggleReasoning: () => undefined,
};

function tool(
  id: string,
  metadata?: Record<string, unknown>,
  state: AnyToolUIPart['state'] = 'output-available',
): AnyToolUIPart {
  return {
    type: 'tool-search',
    toolCallId: id,
    state,
    input: {},
    output: {},
    ...(metadata ? { toolMetadata: metadata } : {}),
  } as AnyToolUIPart;
}

function message(parts: UIMessage['parts']): UIMessage {
  return { id: 'm1', role: 'assistant', parts };
}

function toolsBlock(parts: UIMessage['parts']): TranscriptToolBlock {
  const block = buildTranscriptBlocks(message(parts), openAll).find(
    (candidate) => candidate.kind === 'tools',
  );
  if (block?.kind !== 'tools') throw new Error('no tools block');
  return block;
}

describe('buildTranscriptBlocks — pushed UI', () => {
  it('turns a data-ui part into a positioned ui block', () => {
    const blocks = buildTranscriptBlocks(
      message([
        { type: 'text', text: 'Here:' },
        {
          type: 'data-ui',
          id: 'ui-1',
          data: { id: 'ui-1', component: 'data-table', props: { rows: [1] }, version: 2 },
        },
        { type: 'text', text: 'Done.' },
      ]),
      openAll,
    );
    expect(blocks.map((block) => block.kind)).toEqual(['text', 'ui', 'text']);
    expect(blocks[1]).toEqual({
      kind: 'ui',
      key: 'm1-ui-ui-1',
      id: 'ui-1',
      component: 'data-table',
      props: { rows: [1] },
      version: 2,
    });
  });

  it('drops a data-ui part that names no component', () => {
    const blocks = buildTranscriptBlocks(
      message([{ type: 'data-ui', id: 'x', data: { props: {} } }]),
      openAll,
    );
    expect(blocks).toEqual([]);
  });
});

describe('buildTranscriptBlocks — approval metadata', () => {
  it('folds data-approval-requested into the call without splitting the tool run', () => {
    const block = toolsBlock([
      tool('a', { toolKind: 'read' }),
      tool('b', { toolKind: 'action' }, 'approval-requested'),
      {
        type: 'data-approval-requested',
        id: 'b',
        data: { id: 'b', approver: 'admin', expiresAt: '2026-10-01T00:00:00.000Z' },
      },
      tool('c'),
    ]);
    expect(block.calls.map((call) => call.toolCallId)).toEqual(['a', 'b', 'c']);
    const b = block.calls[1];
    expect(b?.isAwaitingApproval).toBe(true);
    expect(b?.toolKind).toBe('action');
    expect(b?.approval).toEqual({
      approver: 'admin',
      expiresAt: '2026-10-01T00:00:00.000Z',
      reason: null,
      status: 'pending',
      remember: false,
      decidedBy: null,
      decidedVia: null,
      decisionReason: null,
    });
    expect(block.calls[0]?.approval).toBeNull();
  });
});

describe('buildTranscriptBlocks — nested calls', () => {
  it('nests calls under their parent and keeps the flat list intact', () => {
    const block = toolsBlock([
      tool('outer'),
      tool('inner-1', { parentId: 'outer' }),
      tool('inner-2', { parentId: 'outer' }),
      tool('deep', { parentId: 'inner-1' }),
      tool('sibling'),
    ]);
    expect(block.calls).toHaveLength(5);
    expect(block.roots.map((call) => call.toolCallId)).toEqual(['outer', 'sibling']);
    const outer = block.roots[0];
    expect(outer?.children.map((call) => call.toolCallId)).toEqual(['inner-1', 'inner-2']);
    expect(outer?.children[0]?.children.map((call) => call.toolCallId)).toEqual(['deep']);
    expect(outer?.children[0]?.parentId).toBe('outer');
  });

  it('keeps a call whose parent is outside the block, or a cycle, as a root', () => {
    const block = toolsBlock([
      tool('orphan', { parentId: 'elsewhere' }),
      tool('x', { parentId: 'y' }),
      tool('y', { parentId: 'x' }),
    ]);
    expect(block.roots.map((call) => call.toolCallId)).toEqual(['orphan', 'x', 'y']);
    expect(block.roots.every((call) => call.children.length === 0)).toBe(true);
  });
});
