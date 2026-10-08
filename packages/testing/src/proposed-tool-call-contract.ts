import type {
  ActionProposalStore,
  ActionProposalSupersessionStore,
  ActionProposalWorkerStore,
  AgentStore,
  CreateActionProposal,
  ToolCallOutcome,
} from '@dudousxd/nestjs-agent-core';

/**
 * The tool-call record of an independent proposal follows the proposal. In
 * `actionApprovalMode: 'independent'` the turn records the call as `proposed` and ends; approving,
 * executing, rejecting, expiring or superseding the proposal is what settles the call's own record —
 * which the dashboard, the run detail and a host's audit read. Before, it stayed `proposed` forever.
 */
export interface ProposedToolCallContractSubject {
  store: AgentStore &
    ActionProposalStore &
    ActionProposalWorkerStore &
    ActionProposalSupersessionStore & {
      toolCallOutcomes(ids: readonly string[]): Promise<ToolCallOutcome[]>;
    };
  setNow(now: number): void;
}
export interface ProposedToolCallContractCase {
  name: string;
  run(subject: ProposedToolCallContractSubject): Promise<void>;
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** A thread with one assistant message whose action call was proposed as `proposalId`. */
async function proposed(
  store: ProposedToolCallContractSubject['store'],
  options: { replacementKey?: string; toolCallId?: string } = {},
): Promise<{ input: CreateActionProposal; toolCallId: string }> {
  const thread = await store.createThread({ actor: { id: 'owner' } });
  const message = await store.appendMessage({
    threadId: thread.id,
    role: 'assistant',
    content: 'Proposed a refund.',
  });
  const toolCallId = options.toolCallId ?? `call-${crypto.randomUUID()}`;
  const input: CreateActionProposal = {
    tenantRef: null,
    actorRef: 'owner',
    threadId: thread.id,
    id: `proposal-${crypto.randomUUID()}`,
    originRunId: 'run',
    originMessageId: message.id,
    originToolCallId: toolCallId,
    toolName: 'refund',
    input: { amount: 5 },
    confirmation: { title: 'Refund?', verb: 'Refund' },
    approver: 'requester',
    expiresAt: 2000,
    idempotencyKey: `key:${toolCallId}`,
    ...(options.replacementKey !== undefined ? { replacementKey: options.replacementKey } : {}),
  };
  const created =
    options.replacementKey !== undefined
      ? await store.createReplacingActionProposal(input)
      : await store.createActionProposal(input);
  check(created.status === 'created', `proposal created (${created.status})`);
  await store.recordToolCall({
    toolCallId,
    messageId: message.id,
    toolName: 'refund',
    toolType: 'action',
    input: { amount: 5 },
    status: 'proposed',
    proposalId: input.id,
    approver: 'requester',
  });
  return { input, toolCallId };
}

async function outcome(
  store: ProposedToolCallContractSubject['store'],
  toolCallId: string,
): Promise<ToolCallOutcome | undefined> {
  return (await store.toolCallOutcomes([toolCallId]))[0];
}

async function approveAndRun(
  store: ProposedToolCallContractSubject['store'],
  input: CreateActionProposal,
  result: { status: 'succeeded'; result: unknown } | { status: 'failed'; error: string },
): Promise<void> {
  const decided = await store.decideActionProposal(input, input.id, {
    decision: 'approved',
    actorRef: 'reviewer',
    via: 'http',
  });
  check(decided.status === 'applied', `approved (${decided.status})`);
  const claimed = await store.claimNextActionProposal({ workerId: 'worker', leaseMs: 30_000 });
  const lease = claimed?.execution?.lease;
  check(claimed?.id === input.id && lease, 'claimed');
  const settled = await store.settleActionProposal(input, input.id, {
    ...result,
    token: lease.token,
    generation: lease.generation,
  } as never);
  check(settled.status === 'applied', `settled (${settled.status})`);
}

export const PROPOSED_TOOL_CALL_CONTRACT: readonly ProposedToolCallContractCase[] = [
  {
    name: 'a proposed call stays proposed until the proposal is decided, and while it runs',
    async run({ store, setNow }) {
      setNow(1000);
      const { input, toolCallId } = await proposed(store);
      check((await outcome(store, toolCallId))?.status === 'proposed', 'proposed at first');
      await store.decideActionProposal(input, input.id, {
        decision: 'approved',
        actorRef: 'reviewer',
        via: 'http',
      });
      check((await outcome(store, toolCallId))?.status === 'proposed', 'approved, not yet run');
    },
  },
  {
    name: 'an executed proposal marks its call executed, with the output',
    async run({ store, setNow }) {
      setNow(1000);
      const { input, toolCallId } = await proposed(store);
      await approveAndRun(store, input, { status: 'succeeded', result: { refunded: 5 } });
      const settled = await outcome(store, toolCallId);
      check(settled?.status === 'executed', `executed (${settled?.status})`);
      check(
        JSON.stringify(settled.output) === JSON.stringify({ refunded: 5 }),
        `output recorded (${JSON.stringify(settled.output)})`,
      );
    },
  },
  {
    name: 'a failed execution marks its call failed, with the error',
    async run({ store, setNow }) {
      setNow(1000);
      const { input, toolCallId } = await proposed(store);
      await approveAndRun(store, input, { status: 'failed', error: 'gateway down' });
      const settled = await outcome(store, toolCallId);
      check(settled?.status === 'failed', `failed (${settled?.status})`);
      check(settled.error === 'gateway down', `error recorded (${settled.error})`);
    },
  },
  {
    name: 'a rejected proposal marks its call rejected',
    async run({ store, setNow }) {
      setNow(1000);
      const { input, toolCallId } = await proposed(store);
      const decided = await store.decideActionProposal(input, input.id, {
        decision: 'rejected',
        actorRef: 'reviewer',
        via: 'http',
      });
      check(decided.status === 'applied', 'rejected');
      check((await outcome(store, toolCallId))?.status === 'rejected', 'call rejected');
    },
  },
  {
    name: 'a proposal the expiry sweep lapses marks its call expired',
    async run({ store, setNow }) {
      setNow(1000);
      const { toolCallId } = await proposed(store);
      setNow(2000);
      check((await store.expireActionProposals({ limit: 100 })) >= 1, 'swept');
      check((await outcome(store, toolCallId))?.status === 'expired', 'call expired');
    },
  },
  {
    name: 'a decision that finds the proposal lapsed marks its call expired',
    async run({ store, setNow }) {
      setNow(1000);
      const { input, toolCallId } = await proposed(store);
      setNow(2500);
      const late = await store.decideActionProposal(input, input.id, {
        decision: 'approved',
        actorRef: 'reviewer',
        via: 'http',
      });
      check(late.status === 'expired', `late approval refused (${late.status})`);
      check((await outcome(store, toolCallId))?.status === 'expired', 'call expired');
    },
  },
  {
    name: 'a superseded proposal marks its call expired, and the replacement stays proposed',
    async run({ store, setNow }) {
      setNow(1000);
      const first = await proposed(store, { replacementKey: 'order-1' });
      // The replacement proposed in the same conversation.
      const message = await store.appendMessage({
        threadId: first.input.threadId,
        role: 'assistant',
        content: 'Proposed a different refund.',
      });
      const replacement: CreateActionProposal = {
        ...first.input,
        id: `proposal-${crypto.randomUUID()}`,
        originMessageId: message.id,
        originToolCallId: `call-${crypto.randomUUID()}`,
        input: { amount: 7 },
        idempotencyKey: 'key:replacement',
      };
      check(
        (await store.createReplacingActionProposal(replacement)).status === 'created',
        'replacement created',
      );
      await store.recordToolCall({
        toolCallId: replacement.originToolCallId,
        messageId: message.id,
        toolName: 'refund',
        toolType: 'action',
        input: { amount: 7 },
        status: 'proposed',
        proposalId: replacement.id,
      });
      check(
        (await store.getActionProposal(first.input, first.input.id))?.decision === 'superseded',
        'first superseded',
      );
      check((await outcome(store, first.toolCallId))?.status === 'expired', 'first call expired');
      check(
        (await outcome(store, replacement.originToolCallId))?.status === 'proposed',
        'replacement still proposed',
      );
    },
  },
];
