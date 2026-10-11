import { createHash } from 'node:crypto';
import type { AgentService } from '@dudousxd/nestjs-agent';
import {
  type ActionProposalView,
  type Actor,
  type PageContext,
  SCOPE_ROLE_PREFIX,
  humanizeToolName,
  scopeRole,
} from '@dudousxd/nestjs-agent-core';
import { type AgUiSourceFrame, agUiFramesFromNdjson } from '@dudousxd/nestjs-agent-core/ag-ui';

/**
 * What a personal agent's turn does with an `action` call that parks for approval:
 *  - `'approve-delegated'` (default) — approve it when the caller's token grants one of the tool's
 *    `scope:` roles: the user granted that scope at the company, which IS the consent the in-app
 *    approval stands for. Anything else is rejected. An independent proposal
 *    (`actionApprovalMode: 'independent'`) is decided the same way once the run ends, and the turn
 *    waits for it to execute, so the reply never claims an action that did not happen.
 *  - `'reject'` — reject every action; personal agents only read.
 *
 * @experimental Personal Agent Protocol (Poppy) Draft 0.1.
 */
export type PersonalAgentActionPolicy = 'approve-delegated' | 'reject';

/** A component a turn pushed (`ctx.emitUi`), as the turn reads it. */
export interface PersonalAgentTurnComponent {
  id: string;
  name: string;
  props: Record<string, unknown>;
  fallbackText?: string;
}

export interface PersonalAgentTurnInput {
  actor: Actor;
  text: string;
  /** The registered agent that answers. Omitted → the service's default. */
  agentName?: string;
  /** Continue this thread; omitted → a new (transient) one. */
  threadId?: string;
  /** Scopes the caller's token grants; `null` when it grants none (signed out). */
  delegatedScopes: string[] | null;
  actions: PersonalAgentActionPolicy;
  /** Give up (and cancel the run) after this long. */
  timeoutMs: number;
  /** Called once the run started, with the thread it runs in — before its frames are read. */
  onStarted?: (threadId: string, runId: string) => Promise<void>;
  /** The page context the turn runs with. Default `{ channel: 'poppy' }`. */
  pageContext?: PageContext;
  /** What approvals and answers are recorded as coming through. Default `'poppy'`. */
  via?: string;
  /** Each piece of the reply's text as it streams — for a surface that relays it live. */
  onText?: (delta: string) => void | Promise<void>;
  /** Each final component frame, as it arrives. */
  onComponent?: (component: PersonalAgentTurnComponent) => void | Promise<void>;
  /**
   * Execute, in this process, what of the run waits for a worker while the turn is read. Nest's
   * durable engine drives a run it started itself, so this is only for a runner whose dispatcher
   * merely persists one; kept for parity with `@adonis-agora/agent`.
   */
  drive?: (runId: string) => Promise<void>;
}

export interface PersonalAgentTurnAction {
  tool: string;
  argsHash: string;
  /** The granted scopes that authorized it. */
  scopes: string[];
}

/**
 * An independent proposal decided during the turn: the app's own summary of it (the confirmation it
 * would have shown the person) and what the tool returned.
 */
export interface PersonalAgentTurnOutcome {
  tool: string;
  /**
   * `succeeded` — approved and executed; `failed` — approved but did not run (`error` says why);
   * `rejected` — the policy refused it (no granted scope, or `actions: 'reject'`).
   */
  status: 'succeeded' | 'failed' | 'rejected';
  summary: { title: string; detail?: string };
  result?: unknown;
  /** Why a `failed` action did not run. */
  error?: string;
}

export interface PersonalAgentTurnResult {
  threadId: string;
  text: string;
  /** Scopes a refused call needed and the token lacks; `null` when nothing was refused for that. */
  permission: string[] | null;
  /** Tools that RAN under a granted scope (reads and approved actions). */
  actions: PersonalAgentTurnAction[];
  /** Independent proposals the turn decided — the reply carries each. */
  outcomes: PersonalAgentTurnOutcome[];
  /** Why the run failed, when it did. */
  error: string | null;
}

/**
 * What runs a personal agent's turn: start it, read its frames, settle what it parks on.
 * `AgentService` is one; an app with its own runtime writes an adapter with the same shape.
 */
export interface PersonalAgentTurnService
  extends Pick<AgentService, 'chat' | 'subscribe' | 'approve' | 'reject' | 'skip' | 'cancel'>,
    Partial<Pick<AgentService, 'decideActionProposal' | 'listActionProposals' | 'threadOwner'>> {
  /**
   * The roles a tool declares — what an approval and a receipt match the granted scopes against.
   * Omitted → the shared `ToolRegistry`. An app whose registry is built per turn answers it here.
   */
  toolRoles?(toolName: string): string[] | undefined;
}

/** How often a turn looks at an approved proposal while it waits for it to execute. */
const PROPOSAL_POLL_MS = 250;

/** How often a driven turn looks for work of its run left waiting for a worker. */
const DRIVE_POLL_MS = 100;

const REFUSAL = 'A personal agent may not run this action without a granted permission for it.';

function keepDriving(drive: (runId: string) => Promise<void>, runId: string): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pass = async () => {
    await drive(runId).catch(() => {});
    if (stopped) return;
    timer = setTimeout(() => void pass(), DRIVE_POLL_MS);
    timer.unref?.();
  };
  void pass();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

function argsHash(input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(input ?? null))
    .digest('base64url');
}

/** The app's confirmation of a proposal, as an outcome's `summary` — words, never the identifier. */
function summaryOf(
  proposal: Pick<ActionProposalView, 'confirmation'> | undefined,
  toolName: string,
): PersonalAgentTurnOutcome['summary'] {
  const confirmation = proposal?.confirmation;
  if (!confirmation) return { title: humanizeToolName(toolName) || toolName };
  return {
    title: confirmation.title,
    ...(confirmation.detail ? { detail: confirmation.detail } : {}),
  };
}

/**
 * Run one personal agent's turn to completion and read its outcome off the stream: text is the
 * reply, an approval is decided on the spot by {@link PersonalAgentActionPolicy}, a question set is
 * skipped (there is no human on this side to answer it — the agent proceeds on its own
 * assumptions), and a call refused for a scope the token lacks becomes a permission request.
 *
 * The Nest port of `@adonis-agora/agent`'s `runA2aTurn`.
 *
 * @experimental Personal Agent Protocol (Poppy) Draft 0.1.
 */
export async function runPersonalAgentTurn(
  service: PersonalAgentTurnService,
  /** The roles a tool declares (see {@link PersonalAgentTurnService.toolRoles}). */
  toolRoles: (toolName: string) => string[] | undefined,
  input: PersonalAgentTurnInput,
): Promise<PersonalAgentTurnResult> {
  const { runId, threadId } = await service.chat({
    actor: input.actor,
    message: input.text,
    ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
    // A prompt can tell it is answering a personal agent, not the person in the app.
    pageContext: input.pageContext ?? { channel: 'poppy' },
    ...(input.threadId !== undefined ? { threadId: input.threadId } : { transient: true }),
  });

  const result: PersonalAgentTurnResult = {
    threadId,
    text: '',
    permission: null,
    actions: [],
    outcomes: [],
    error: null,
  };
  const delegated = input.delegatedScopes ?? [];
  // The granted scopes a tool's roles name (as `scope:<id>` roles).
  const scopesOf = (tool: string) => {
    const roles = toolRoles(tool) ?? [];
    return delegated.filter((scope) => roles.includes(scopeRole(scope)));
  };
  // Announced calls, by id, until their output says they ran.
  const calls = new Map<string, { name: string; input: unknown }>();
  // Independent proposals the run left behind, decided once it ends.
  const proposals: { id: string; toolName: string; toolCallId: string }[] = [];
  // Set once the turn answered (or gave up): a wait still polling stops there.
  let finished = false;
  const cancel = () => service.cancel(input.actor, runId).catch(() => {});
  const via = input.via ?? 'poppy';

  /**
   * Decide the proposals by {@link PersonalAgentActionPolicy} and wait for the approved ones to
   * execute. One the caller may not decide (another approver) stays with the app, and is not
   * reported as done.
   */
  const settleProposals = async (): Promise<void> => {
    const { decideActionProposal, listActionProposals } = service;
    if (!decideActionProposal || !listActionProposals) return;
    for (const proposal of proposals) {
      const scopes = scopesOf(proposal.toolName);
      const approve = input.actions === 'approve-delegated' && scopes.length > 0;
      try {
        await decideActionProposal.call(service, input.actor, threadId, proposal.id, {
          decision: approve ? 'approved' : 'rejected',
          ...(approve ? {} : { reason: REFUSAL }),
          via,
        });
      } catch {
        continue;
      }
      if (!approve) {
        // Refused by the policy: say so, with the app's own summary of what was asked.
        const listed = await listActionProposals
          .call(service, input.actor, threadId)
          .catch(() => [] as ActionProposalView[]);
        result.outcomes.push({
          tool: proposal.toolName,
          status: 'rejected',
          summary: summaryOf(
            listed.find((p) => p.id === proposal.id),
            proposal.toolName,
          ),
        });
        continue;
      }
      while (!finished) {
        const listed = await listActionProposals.call(service, input.actor, threadId);
        const current = listed.find((p) => p.id === proposal.id);
        const status = current?.execution?.status;
        if (current?.decision !== 'approved' || status === 'failed') {
          result.error = current?.execution?.error ?? `${proposal.toolName} did not run`;
          result.outcomes.push({
            tool: proposal.toolName,
            status: 'failed',
            summary: summaryOf(current, proposal.toolName),
            error: result.error,
          });
          return;
        }
        if (status === 'succeeded') {
          result.actions.push({
            tool: proposal.toolName,
            argsHash: argsHash(calls.get(proposal.toolCallId)?.input ?? current.input),
            scopes,
          });
          // The model never sees an independent proposal's result: the app's own summary and the
          // tool's output go back as data, whatever the model wrote before calling it.
          result.outcomes.push({
            tool: proposal.toolName,
            status: 'succeeded',
            summary: summaryOf(current, proposal.toolName),
            ...(current.execution?.result !== undefined
              ? { result: current.execution.result }
              : {}),
          });
          const said = current.outcome?.text?.trim();
          if (said) result.text = result.text ? `${result.text}\n\n${said}` : said;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, PROPOSAL_POLL_MS));
      }
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  // A HARD deadline: if cancelling does not end the stream, the request still answers.
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), input.timeoutMs);
  });
  const stream = agUiFramesFromNdjson(service.subscribe(runId))[Symbol.asyncIterator]();
  const stopDriving = input.drive ? keepDriving(input.drive, runId) : undefined;

  try {
    await input.onStarted?.(threadId, runId);
    for (;;) {
      const next = await Promise.race([stream.next(), deadline]);
      if (next === 'timeout') {
        result.error = 'timeout';
        await cancel();
        break;
      }
      if (next.done) break;
      const frame: AgUiSourceFrame = next.value;
      switch (frame.kind) {
        case 'text':
          result.text += frame.text;
          if (frame.text !== '') await input.onText?.(frame.text);
          break;
        case 'ui':
          // A preview of a layout still being written: only the final component counts.
          if (frame.partial === true) break;
          await input.onComponent?.({
            id: frame.id ?? `ui:${frame.component}`,
            name: frame.component,
            props:
              frame.props !== null && typeof frame.props === 'object'
                ? (frame.props as Record<string, unknown>)
                : {},
            ...(frame.fallbackText !== undefined ? { fallbackText: frame.fallbackText } : {}),
          });
          break;
        case 'tool-input-start':
          if (!calls.has(frame.id)) calls.set(frame.id, { name: frame.name, input: undefined });
          break;
        case 'tool-input-available':
          calls.set(frame.id, { name: frame.name, input: frame.input });
          break;
        case 'tool-output-error': {
          // A tool behind a scope the caller was not granted is offered but not run
          // (`personalAgentGate`): its refused call IS the request for that scope.
          const call = calls.get(frame.id);
          const missing = (call ? (toolRoles(call.name) ?? []) : [])
            .filter((role) => role.startsWith(SCOPE_ROLE_PREFIX))
            .map((role) => role.slice(SCOPE_ROLE_PREFIX.length))
            .filter((scope) => !delegated.includes(scope));
          if (missing.length > 0) {
            result.permission = [...new Set([...(result.permission ?? []), ...missing])];
          }
          break;
        }
        case 'tool-output': {
          const call = calls.get(frame.id);
          const scopes = call ? scopesOf(call.name) : [];
          if (call && scopes.length > 0) {
            result.actions.push({ tool: call.name, argsHash: argsHash(call.input), scopes });
          }
          break;
        }
        case 'approval-requested': {
          const toolName = calls.get(frame.id)?.name ?? 'action';
          if (frame.target?.kind === 'proposal') {
            proposals.push({ id: frame.target.proposalId, toolName, toolCallId: frame.id });
            break;
          }
          if (input.actions === 'approve-delegated' && scopesOf(toolName).length > 0) {
            await service.approve(input.actor, frame.id, { via });
          } else {
            await service.reject(input.actor, frame.id, REFUSAL, { via });
          }
          break;
        }
        case 'elicitation':
          await service.skip(input.actor, frame.id, { via });
          break;
        case 'error':
          result.error = frame.message;
          break;
        default:
          break;
      }
    }
    if (result.error === null && proposals.length > 0) {
      const settled = await Promise.race([settleProposals(), deadline]);
      if (settled === 'timeout') result.error = 'timeout';
    }
  } catch (error) {
    // Nobody will read this run's stream any more: leaving it parked would hold the thread's
    // active stream, and every later message to this conversation would be refused as busy.
    await cancel();
    throw error;
  } finally {
    finished = true;
    stopDriving?.();
    clearTimeout(timer);
    void stream.return?.(undefined);
  }
  return result;
}
