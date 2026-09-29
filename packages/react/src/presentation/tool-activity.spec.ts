import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { type AnyToolUIPart, buildTranscriptBlocks } from '../transcript/model.js';
import type { ToolCatalog } from './phrasing.js';
import {
  correctedCallIds,
  describeToolCall,
  groupToolActivity,
  toolCallState,
} from './tool-activity.js';

function part(
  id: string,
  name: string,
  state: AnyToolUIPart['state'],
  extra: Record<string, unknown> = {},
): AnyToolUIPart {
  return { type: `tool-${name}`, toolCallId: id, state, input: {}, ...extra } as AnyToolUIPart;
}

const catalog: ToolCatalog = {
  query: {
    label: 'Database query',
    running: 'Querying {table}',
    done: 'Queried {table}',
    icon: 'database',
    result: { kind: 'metrics', fields: [{ path: 'count', label: 'Rows' }] },
  },
  purge: {
    label: 'Cache purge',
    running: 'Purging {key}',
    done: 'Purged {key}',
    tone: 'destructive',
    confirm: { title: 'Purge {key}?', verb: 'Purge', detail: 'Clears {key} everywhere' },
  },
};

function toolBlock(parts: AnyToolUIPart[], toolCatalog?: ToolCatalog) {
  const message: UIMessage = { id: 'm', role: 'assistant', parts };
  const block = buildTranscriptBlocks(message, {
    isReasoningOpen: () => false,
    toggleReasoning: () => undefined,
    ...(toolCatalog !== undefined ? { toolCatalog } : {}),
  })[0];
  if (block?.kind !== 'tools') throw new Error('expected a tool block');
  return block;
}

describe('toolCallState', () => {
  it('reads every state a person can see', () => {
    expect(toolCallState(part('a', 'x', 'input-streaming')).status).toBe('running');
    expect(toolCallState(part('a', 'x', 'input-available')).status).toBe('running');
    expect(
      toolCallState(part('a', 'x', 'input-available', { toolMetadata: { toolKind: 'action' } }))
        .status,
    ).toBe('awaiting-approval');
    expect(toolCallState(part('a', 'x', 'approval-requested')).status).toBe('awaiting-approval');
    expect(toolCallState(part('a', 'x', 'output-available', { output: {} })).status).toBe('done');
    expect(toolCallState(part('a', 'x', 'output-error', { errorText: 'boom' }))).toMatchObject({
      status: 'failed',
      error: 'boom',
    });
    expect(toolCallState(part('a', 'x', 'output-denied')).status).toBe('denied');
  });

  it('treats a returned { error } as a failure', () => {
    expect(
      toolCallState(part('a', 'x', 'output-available', { output: { error: 'no table' } })),
    ).toMatchObject({ status: 'failed', error: 'no table' });
  });
});

describe('correctedCallIds', () => {
  it('marks a failure the same tool later recovered from, and nothing else', () => {
    const parts = [
      part('1', 'query', 'output-error', { errorText: 'x' }),
      part('2', 'read', 'output-error', { errorText: 'x' }),
      part('3', 'query', 'output-available', { output: {} }),
    ];
    expect([...correctedCallIds(parts)]).toEqual(['1']);
  });
});

describe('describeToolCall', () => {
  it("speaks in the tool's declared words and resolves its result once done", () => {
    const description = describeToolCall(
      part('1', 'query', 'output-available', { input: { table: 'orders' }, output: { count: 4 } }),
      catalog,
    );
    expect(description).toMatchObject({
      status: 'done',
      phrase: 'Queried orders',
      label: 'Database query',
      icon: 'database',
      tone: 'neutral',
      result: { kind: 'metrics', readings: [{ label: 'Rows', value: '4', unit: null }] },
    });
  });

  it('fills the approval prompt from the input', () => {
    const description = describeToolCall(
      part('1', 'purge', 'approval-requested', { input: { key: 'sessions' } }),
      catalog,
    );
    expect(description).toMatchObject({
      status: 'awaiting-approval',
      phrase: 'Purging sessions',
      tone: 'destructive',
      confirm: { title: 'Purge sessions?', verb: 'Purge', detail: 'Clears sessions everywhere' },
      result: null,
    });
  });

  it('narrates an undescribed tool generically', () => {
    expect(describeToolCall(part('1', 'mystery', 'input-available'), catalog)).toMatchObject({
      phrase: 'Working',
      label: null,
      presentation: null,
    });
  });
});

describe('groupToolActivity', () => {
  it('folds repeats under one label with a count, worst status first, latest phrase', () => {
    const block = toolBlock(
      [
        part('1', 'query', 'output-available', { input: { table: 'a' }, output: {} }),
        part('2', 'query', 'output-error', { input: { table: 'b' }, errorText: 'x' }),
        part('3', 'query', 'input-available', { input: { table: 'c' } }),
        part('4', 'purge', 'output-available', { input: { key: 'k' }, output: {} }),
      ],
      catalog,
    );
    expect(
      block.activity.map(({ key, count, status, phrase }) => ({ key, count, status, phrase })),
    ).toEqual([
      { key: 'Database query', count: 3, status: 'running', phrase: 'Querying c' },
      { key: 'Cache purge', count: 1, status: 'done', phrase: 'Purged k' },
    ]);
  });

  it('counts nested calls under their parent, or expands them into their own groups', () => {
    const block = toolBlock([
      part('outer', 'execute', 'output-available', { output: {} }),
      part('i1', 'github_search', 'output-available', {
        output: {},
        toolMetadata: { toolKind: 'read', parentId: 'outer' },
      }),
      part('i2', 'github_search', 'input-available', {
        toolMetadata: { toolKind: 'read', parentId: 'outer' },
      }),
      part('i3', 'linear_get', 'output-available', {
        output: {},
        toolMetadata: { toolKind: 'read', parentId: 'outer' },
      }),
    ]);
    expect(
      groupToolActivity(block.roots).map(({ key, count, innerCount }) => ({
        key,
        count,
        innerCount,
      })),
    ).toEqual([{ key: 'execute', count: 1, innerCount: 3 }]);

    const bySource = groupToolActivity(block.roots, {
      expandNested: true,
      keyOf: (call) => call.name.split('_')[0] ?? call.name,
    });
    expect(bySource.map(({ key, count, status }) => ({ key, count, status }))).toEqual([
      { key: 'github', count: 2, status: 'running' },
      { key: 'linear', count: 1, status: 'done' },
    ]);
  });

  it('can hide failures the model corrected', () => {
    const block = toolBlock([
      part('1', 'query', 'output-error', { errorText: 'x' }),
      part('2', 'query', 'output-available', { output: {} }),
    ]);
    expect(groupToolActivity(block.roots, { hideCorrected: true })[0]).toMatchObject({
      count: 1,
      status: 'done',
    });
  });
});

describe('transcript integration', () => {
  it('gives every call a description, generic without a catalog and worded with one', () => {
    const parts = [part('1', 'query', 'input-available', { input: { table: 'orders' } })];
    expect(toolBlock(parts).calls[0]?.description.phrase).toBe('Working');
    expect(toolBlock(parts, catalog).calls[0]?.description.phrase).toBe('Querying orders');
  });
});
