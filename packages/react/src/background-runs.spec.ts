import type { StoredMessage } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it } from 'vitest';
import { backgroundRunsFromThread } from './background-runs.js';

function message(partial: Partial<StoredMessage> & { id: string }): StoredMessage {
  return {
    role: 'assistant',
    content: '',
    createdAt: '2026-09-11T00:00:00.000Z',
    ...partial,
  };
}

const receipt = {
  detached: true,
  status: 'started',
  agent: 'research',
  runId: 'run-child',
  note: 'working on it',
};

const delegation = message({
  id: 'm2',
  runId: 'run-parent',
  content: 'starting the research agent',
  toolCalls: [{ id: 'tc-1', name: 'ask_research', input: { task: 'dig' }, kind: 'agent' }],
  toolResults: [{ id: 'tc-1', name: 'ask_research', output: receipt }],
});

describe('backgroundRunsFromThread', () => {
  it('reports a delegation nothing has answered yet as running', () => {
    expect(backgroundRunsFromThread([message({ id: 'm1', role: 'user' }), delegation])).toEqual([
      {
        runId: 'run-child',
        agent: 'research',
        toolCallId: 'tc-1',
        toolName: 'ask_research',
        status: 'running',
      },
    ]);
  });

  it('pairs it with the message its own run posted', () => {
    const delivered = message({ id: 'm3', runId: 'run-child', content: 'RESEARCH ANSWER' });
    const [run] = backgroundRunsFromThread([delegation, delivered]);
    expect(run?.status).toBe('delivered');
    expect(run?.message).toBe(delivered);
  });

  it('does not pair it with a message from another run that merely came later', () => {
    const other = message({ id: 'm3', runId: 'run-somebody-else', content: 'unrelated' });
    expect(backgroundRunsFromThread([delegation, other])[0]?.status).toBe('running');
  });

  it('ignores an ordinary tool result that is not a delegation receipt', () => {
    const ordinary = message({
      id: 'm2',
      runId: 'run-parent',
      toolResults: [{ id: 'tc-1', name: 'getWeather', output: { tempC: 21, runId: 'run-child' } }],
    });
    expect(backgroundRunsFromThread([ordinary])).toEqual([]);
  });

  it('reports one run per delegation, however many messages mention it', () => {
    const twice = [delegation, { ...delegation, id: 'm9' }];
    expect(backgroundRunsFromThread(twice)).toHaveLength(1);
  });
});
