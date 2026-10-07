// @vitest-environment jsdom
import { type TranscriptToolBlock, useChatTranscript } from '@dudousxd/nestjs-agent-react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { ChatToolGroup } from './chat-tool-group';

function part(overrides: Record<string, unknown>) {
  return {
    type: 'tool-purgeCache',
    toolCallId: 'call-2',
    state: 'input-available',
    input: { key: 'all' },
    ...overrides,
  } as UIMessage['parts'][number];
}

const ACTION = part({ toolMetadata: { toolKind: 'action' } });
const READ = part({
  type: 'tool-executeSql',
  toolCallId: 'call-1',
  state: 'output-available',
  input: { query: 'SELECT 1' },
  output: { rows: [] },
  toolMetadata: { toolKind: 'read' },
});

interface HarnessProps {
  parts?: UIMessage['parts'];
  onApprove?: (input: { toolCallId: string }) => void | Promise<void>;
  onReject?: (input: { toolCallId: string }) => void | Promise<void>;
  renderToolPart?: Parameters<typeof ChatToolGroup>[0]['renderToolPart'];
}

function Harness({ parts = [ACTION], onApprove, onReject, renderToolPart }: HarnessProps) {
  const transcript = useChatTranscript({
    messages: [{ id: 'm1', role: 'assistant', parts }],
    status: 'streaming',
    onApprove: onApprove ?? null,
    onReject: onReject ?? null,
  });
  const block = transcript.items[0]?.blocks[0] as TranscriptToolBlock;
  return <ChatToolGroup block={block} renderToolPart={renderToolPart} />;
}

describe('ChatToolGroup', () => {
  it('draws one card per call in the run', () => {
    render(<Harness parts={[READ, ACTION]} />);
    expect(screen.getByText('executeSql')).toBeTruthy();
    expect(screen.getByText('purgeCache')).toBeTruthy();
  });

  it('says a call is waiting on a person rather than still running', () => {
    render(<Harness onApprove={() => undefined} />);
    expect(screen.getByText('Needs approval')).toBeTruthy();
  });

  it('sends an approval for the call parked on a human', () => {
    const onApprove = vi.fn();
    render(<Harness onApprove={onApprove} onReject={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(onApprove).toHaveBeenCalledWith({ toolCallId: 'call-2' });
  });

  it('sends a rejection for it just the same', () => {
    const onReject = vi.fn();
    render(<Harness onApprove={() => undefined} onReject={onReject} />);

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));

    expect(onReject).toHaveBeenCalledWith({ toolCallId: 'call-2' });
  });

  it('closes both doors once a decision is on its way, so the other cannot follow it', () => {
    const onReject = vi.fn();
    render(<Harness onApprove={() => new Promise<void>(() => undefined)} onReject={onReject} />);

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));

    expect(onReject).not.toHaveBeenCalled();
  });

  it('offers nothing on a call nobody is waiting on', () => {
    render(<Harness parts={[READ]} onApprove={() => undefined} onReject={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('announces a refused decision on the card it belongs to', async () => {
    const onApprove = vi.fn(() => Promise.reject(new Error('not your thread')));
    render(<Harness onApprove={onApprove} />);

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'not your thread');
  });

  it('hands the whole call to a host that draws its own', () => {
    render(
      <Harness
        onApprove={() => undefined}
        renderToolPart={(call) => (
          <div key={call.toolCallId}>
            {call.name} {call.isAwaitingApproval ? 'waiting' : 'done'}
          </div>
        )}
      />,
    );

    expect(screen.getByText('purgeCache waiting')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  describe('an independently approved action (a proposal)', () => {
    const confirmation = { title: 'Purge every cache?', verb: 'Purge', detail: 'All regions.' };
    const proposal = (data: Record<string, unknown>) =>
      ({
        type: 'data-action-proposal',
        data: {
          id: 'call-2',
          target: { kind: 'proposal', proposalId: 'p-1', threadId: 't-1' },
          approver: 'requester',
          confirmation,
          ...data,
        },
      }) as UIMessage['parts'][number];
    // In independent mode the call itself settles at once on a receipt; the work runs later.
    const RECEIPT = part({
      state: 'output-available',
      output: { proposalId: 'p-1', status: 'pending' },
      toolMetadata: { toolKind: 'action' },
    });

    it('asks in the confirmation wording, with its verb on the button', () => {
      render(
        <Harness
          parts={[RECEIPT, proposal({ status: 'pending' })]}
          onApprove={() => undefined}
          onReject={() => undefined}
        />,
      );
      expect(screen.getByText('Purge every cache?')).toBeTruthy();
      expect(screen.getByText('All regions.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Purge' })).toBeTruthy();
      expect(screen.getByText('Awaiting approval')).toBeTruthy();
    });

    it('shows an approved proposal as queued, not done, while the work waits', () => {
      render(
        <Harness parts={[RECEIPT, proposal({ status: 'approved', executionStatus: 'queued' })]} />,
      );
      expect(screen.getByText('Queued')).toBeTruthy();
      expect(screen.queryByText('Done')).toBeNull();
    });

    it('shows a rejected proposal as a failure', () => {
      render(<Harness parts={[RECEIPT, proposal({ status: 'rejected' })]} />);
      expect(screen.getByText('Rejected')).toBeTruthy();
    });
  });
});
