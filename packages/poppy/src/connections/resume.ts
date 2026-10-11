import type { AgentService } from '@dudousxd/nestjs-agent';
import type {
  ActionProposal,
  ActionProposalOutcome,
  ActionProposalScope,
  Actor,
  PageContext,
  PoppyPendingConnect,
  ToolCallApprovalState,
} from '@dudousxd/nestjs-agent-core';
import type { PoppyConnections } from './service.js';

/** Delivers a run the server started to the text channel `address` names (`ChannelFollower`). */
export type PoppyFollow = (
  address: unknown,
  run: { runId: string; threadId: string; actor: Actor },
) => Promise<unknown>;

/**
 * The slice of the agent's store resuming reads: the parked call's approval state (blocking mode)
 * and a proposal's execution context (its agent and page context — the channel to deliver to),
 * which the public proposal view leaves out.
 */
export interface PoppyResumeStore {
  toolCallApproval?(toolCallId: string): Promise<ToolCallApprovalState | null>;
  getThreadActionProposalScope?(threadId: string): Promise<ActionProposalScope | null>;
  getActionProposal?(scope: ActionProposalScope, id: string): Promise<ActionProposal | null>;
}

/** What {@link resumeAfterConnect} decides through. */
export interface PoppyResumeHost {
  service: Pick<
    AgentService,
    'actionApprovalMode' | 'listActionProposals' | 'decideActionProposal' | 'approve'
  > &
    Partial<Pick<AgentService, 'send'>>;
  store?: PoppyResumeStore | undefined;
}

type ExecutionContext = { agentName?: string; pageContext?: PageContext } | undefined;

/** The execution context a proposal was made with — read off the store (the view omits it). */
async function executionContextOf(
  store: PoppyResumeStore | undefined,
  threadId: string,
  proposalId: string | undefined,
): Promise<ExecutionContext> {
  if (proposalId === undefined || !store?.getActionProposal) return undefined;
  const scope = (await store.getThreadActionProposalScope?.(threadId)) ?? null;
  if (scope === null) return undefined;
  const proposal = await store.getActionProposal(scope, proposalId).catch(() => null);
  return proposal?.executionContext;
}

/**
 * A connect finished: decide the `connect` call the turn parked on, so the conversation resumes
 * with the account connected — a scoped proposal decision under `actionApprovalMode: 'independent'`,
 * an approval of the parked call otherwise. A call already decided (the person tapped first) is left.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec).
 */
export async function resumeAfterConnect(
  host: PoppyResumeHost,
  pending: PoppyPendingConnect,
  /**
   * For a sign-in that finished after its card expired: the connection is stored all the same, and
   * the conversation is continued with a new turn (`texts.continueAfterConnect`) instead of nothing
   * happening. Without it, an expired card is left alone.
   */
  late?: { connections: Pick<PoppyConnections, 'texts'>; follow?: PoppyFollow },
): Promise<void> {
  if (!pending.actor || !pending.threadId || !pending.toolCallId) return;
  const { service, store } = host;
  const actor: Actor = pending.actor;
  const threadId = pending.threadId;
  if (service.actionApprovalMode() === 'independent') {
    const mine = (await service.listActionProposals(actor, threadId)).filter(
      (p) => p.originToolCallId === pending.toolCallId,
    );
    const open = mine.find((p) => p.decision === 'pending');
    if (open) {
      const decided = await service
        .decideActionProposal(actor, threadId, open.id, {
          decision: 'approved',
          via: 'poppy-connect',
        })
        .then(
          (r) => r.proposalDecision.status !== 'expired',
          () => false,
        );
      if (decided) return;
    }
    // Approved already (the person tapped first) or turned down: nothing to add.
    const settled = (await service.listActionProposals(actor, threadId)).filter(
      (p) => p.originToolCallId === pending.toolCallId,
    );
    if (settled.some((p) => p.decision === 'approved' || p.decision === 'rejected')) return;
    // Expired (or gone) before the sign-in finished: the account is connected anyway — go on.
    const context = await executionContextOf(store, threadId, settled[0]?.id ?? mine[0]?.id);
    await continueLate(service, late, actor, threadId, pending, context);
    return;
  }
  // A store that cannot say (no `toolCallApproval`) is taken to hold the call parked; one that
  // does not know the call has nothing to resume.
  if (!store?.toolCallApproval) {
    await service.approve(actor, pending.toolCallId, { via: 'poppy-connect' });
    return;
  }
  const state = await store.toolCallApproval(pending.toolCallId);
  if (state === null) return;
  if (state.status === 'pending_approval') {
    await service.approve(actor, pending.toolCallId, { via: 'poppy-connect' });
    return;
  }
  if (state.status === 'expired') await continueLate(service, late, actor, threadId, pending);
}

async function continueLate(
  service: Partial<Pick<AgentService, 'send'>>,
  late: Parameters<typeof resumeAfterConnect>[2],
  actor: Actor,
  threadId: string,
  pending: PoppyPendingConnect,
  context?: ExecutionContext,
): Promise<void> {
  if (!late || !service.send) return;
  const runId = await sendContinuation(
    service.send.bind(service),
    actor,
    threadId,
    late.connections.texts.continueAfterConnect.replace(/\{company\}/g, pending.organization),
    context,
  );
  const address = context?.pageContext?.channel;
  if (runId !== undefined && late.follow && address !== null && typeof address === 'object') {
    await late.follow(address, { runId, threadId, actor });
  }
}

/** The next turn, in the person's voice; the run it started (`undefined` when queued). */
async function sendContinuation(
  send: AgentService['send'],
  actor: Actor,
  threadId: string,
  message: string,
  context: ExecutionContext,
): Promise<string | undefined> {
  const sent = await send(
    {
      actor,
      threadId,
      message,
      ...(context?.agentName !== undefined ? { agentName: context.agentName } : {}),
      ...(context?.pageContext !== undefined ? { pageContext: context.pageContext } : {}),
    },
    { textDecisions: false },
  );
  return 'runId' in sent && typeof sent.runId === 'string' ? sent.runId : undefined;
}

/**
 * Independent approvals: deciding the `connect` proposal runs it, and its outcome is written to the
 * thread — but nothing asks the model to go on. Once that outcome is admitted (the
 * action-proposal worker's `onAdmitted`), this starts the next turn on the thread, in the person's
 * voice (`texts.continueAfterConnect`), so the model proceeds with what was asked before the
 * sign-in. A text channel's conversation gets that turn too (`follow`).
 *
 * Only for a connect this app's connect page completed (its pending connect is `connected`), and
 * only once: the outcome is admitted once.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec).
 */
export async function continueAfterConnect(
  host: { service: Pick<AgentService, 'send'>; store?: PoppyResumeStore | undefined },
  connections: Pick<PoppyConnections, 'pendingFor' | 'texts'>,
  outcome: ActionProposalOutcome,
  options: {
    prefix?: string;
    /** Deliver the new run to a text channel (`ChannelFollower.follow`). */
    follow?: PoppyFollow;
  } = {},
): Promise<{ runId: string } | null> {
  if (outcome.toolName !== `${options.prefix ?? 'poppy_'}connect`) return null;
  if (outcome.executionStatus !== 'succeeded' || outcome.decision !== 'approved') return null;
  const result = outcome.result as { connected?: unknown; organization?: unknown } | undefined;
  if (result?.connected !== true) return null;
  const pending = await connections.pendingFor(outcome.originRunId, outcome.originToolCallId);
  if (pending === null || pending.status !== 'connected' || pending.actor === null) return null;
  const actor: Actor = pending.actor;
  const scope = {
    tenantRef: outcome.tenantRef,
    actorRef: outcome.actorRef,
    threadId: outcome.threadId,
  };
  const proposal = await host.store
    ?.getActionProposal?.(scope, outcome.proposalId)
    .catch(() => null);
  const context = proposal?.executionContext;
  const company =
    typeof result.organization === 'string' ? result.organization : pending.organization;
  const runId = await sendContinuation(
    host.service.send.bind(host.service),
    actor,
    outcome.threadId,
    connections.texts.continueAfterConnect.replace(/\{company\}/g, company),
    context,
  );
  if (runId === undefined) return null;
  const address = context?.pageContext?.channel;
  if (options.follow && address !== null && typeof address === 'object') {
    await options.follow(address, { runId, threadId: outcome.threadId, actor });
  }
  return { runId };
}
