// @vitest-environment jsdom
import type { StoredMessage } from '@dudousxd/nestjs-agent-core';
import { act, renderHook } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storedMessageToUiMessage } from '../stored-message-to-ui-message.js';
import {
  type AnyToolUIPart,
  type TranscriptToolBlock,
  buildTranscriptBlocks,
} from '../transcript/model.js';
import { approvalCountdown, useApprovalCountdown } from './countdown.js';

const openAll = {
  isReasoningOpen: (_key: string, isStreaming: boolean) => isStreaming,
  toggleReasoning: () => undefined,
};

function toolsBlock(
  parts: UIMessage['parts'],
  approval?: Parameters<typeof buildTranscriptBlocks>[1]['approval'],
): TranscriptToolBlock {
  const block = buildTranscriptBlocks(
    { id: 'm1', role: 'assistant', parts },
    { ...openAll, ...(approval !== undefined ? { approval } : {}) },
  ).find((candidate) => candidate.kind === 'tools');
  if (block?.kind !== 'tools') throw new Error('no tools block');
  return block;
}

function action(id: string, state: AnyToolUIPart['state']): AnyToolUIPart {
  return {
    type: 'tool-purge',
    toolCallId: id,
    state,
    input: {},
    ...(state === 'output-available' ? { output: {} } : {}),
    toolMetadata: { toolKind: 'action' },
  } as AnyToolUIPart;
}

describe('call.approval — how an approval settled', () => {
  it('folds a settlement into the request: who decided, through what, remembered', () => {
    const block = toolsBlock([
      action('c1', 'output-available'),
      { type: 'data-approval-requested', id: 'c1', data: { id: 'c1', approver: 'ops' } },
      {
        type: 'data-approval-settled',
        id: 'c1',
        data: {
          id: 'c1',
          status: 'approved',
          decidedBy: 'op-1',
          decidedVia: 'slack',
          remember: true,
        },
      },
    ]);
    expect(block.calls[0]?.approval).toEqual({
      approver: 'ops',
      expiresAt: null,
      reason: null,
      status: 'approved',
      remember: true,
      decidedBy: 'op-1',
      decidedVia: 'slack',
      decisionReason: null,
    });
  });

  it('reads an expiry and a rejection reason', () => {
    const block = toolsBlock([
      action('c1', 'output-denied'),
      action('c2', 'output-denied'),
      {
        type: 'data-approval-requested',
        id: 'c1',
        data: { id: 'c1', approver: 'requester', expiresAt: '2026-10-01T00:00:00.000Z' },
      },
      { type: 'data-approval-settled', id: 'c1', data: { id: 'c1', status: 'expired' } },
      { type: 'data-approval-requested', id: 'c2', data: { id: 'c2', approver: 'requester' } },
      {
        type: 'data-approval-settled',
        id: 'c2',
        data: { id: 'c2', status: 'rejected', decidedBy: 'u1', reason: 'not now' },
      },
    ]);
    expect(block.calls[0]?.approval).toMatchObject({ status: 'expired', decidedBy: null });
    expect(block.calls[1]?.approval).toMatchObject({
      status: 'rejected',
      decidedBy: 'u1',
      decisionReason: 'not now',
    });
  });

  it('takes a remembered approval that streamed no request', () => {
    const block = toolsBlock([
      action('c1', 'output-available'),
      {
        type: 'data-approval-settled',
        id: 'c1',
        data: { id: 'c1', status: 'approved', approver: 'requester', decidedVia: 'remembered' },
      },
    ]);
    expect(block.calls[0]?.approval).toMatchObject({
      approver: 'requester',
      status: 'approved',
      decidedVia: 'remembered',
    });
  });

  it('falls back to the call state for a runner that streams no settlement', () => {
    const block = toolsBlock([
      action('c1', 'output-denied'),
      action('c2', 'output-available'),
      action('c3', 'input-available'),
      { type: 'data-approval-requested', id: 'c1', data: { id: 'c1', approver: 'requester' } },
      { type: 'data-approval-requested', id: 'c2', data: { id: 'c2', approver: 'requester' } },
      { type: 'data-approval-requested', id: 'c3', data: { id: 'c3', approver: 'requester' } },
    ]);
    expect(block.calls.map((call) => call.approval?.status)).toEqual([
      'rejected',
      'approved',
      'pending',
    ]);
  });

  it('passes remember through approve.run', () => {
    const approve = vi.fn();
    const block = toolsBlock([action('c1', 'input-available')], {
      canApprove: true,
      canReject: true,
      approve,
      reject: () => undefined,
      submitting: () => null,
      errorOf: () => null,
    });
    block.calls[0]?.approve.run({ remember: true });
    block.calls[0]?.approve.run();
    expect(approve.mock.calls).toEqual([['c1', { remember: true }], ['c1']]);
  });
});

describe('storedMessageToUiMessage — approvals on a reloaded thread', () => {
  it('replays the approval record as the parts a live stream produces', () => {
    const stored: StoredMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      toolCalls: [
        { id: 'c1', name: 'purge', input: {}, kind: 'action' },
        { id: 'c2', name: 'purge', input: {}, kind: 'action' },
      ],
      toolResults: [
        {
          id: 'c2',
          name: 'purge',
          output: { rejected: true, expired: true, reason: 'approval expired' },
          denied: true,
          expired: true,
          error: 'expired',
        },
      ],
      approvals: [
        {
          toolCallId: 'c1',
          approver: 'ops',
          status: 'pending',
          expiresAt: '2030-01-01T00:00:00.000Z',
        },
        { toolCallId: 'c2', approver: 'requester', status: 'expired' },
      ],
    };
    const block = toolsBlock(storedMessageToUiMessage(stored).parts);
    expect(block.calls[0]?.approval).toMatchObject({
      approver: 'ops',
      status: 'pending',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    expect(block.calls[0]?.isAwaitingApproval).toBe(true);
    expect(block.calls[1]?.part.state).toBe('output-denied');
    expect(block.calls[1]?.approval).toMatchObject({ status: 'expired' });
  });
});

describe('useApprovalCountdown', () => {
  let now = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    now = Date.parse('2026-01-01T00:00:00.000Z');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads nothing for a request that never lapses', () => {
    expect(approvalCountdown(null, now)).toEqual({ remainingMs: null, isExpired: false });
    expect(approvalCountdown('not a date', now)).toEqual({ remainingMs: null, isExpired: false });
  });

  it('ticks down to zero and then reports the lapse', () => {
    const { result } = renderHook(() =>
      useApprovalCountdown('2026-01-01T00:00:03.000Z', { now: () => now }),
    );
    expect(result.current).toEqual({ remainingMs: 3000, isExpired: false });
    act(() => {
      now += 1000;
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.remainingMs).toBe(2000);
    act(() => {
      now += 5000;
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toEqual({ remainingMs: 0, isExpired: true });
  });
});
