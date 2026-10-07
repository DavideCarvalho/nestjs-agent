import {
  AGENT_OPTIONS,
  AGENT_STORE,
  type ActionProposalMutationResult,
  type ActionProposalOutcomeStore,
  type ActionProposalScope,
  type ActionProposalStore,
  type Actor,
  type AgentStore,
  DEFAULT_TEXT_ACTION_PROPOSAL_REPLIES,
  DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY,
  type ListActionProposals,
  type TextActionProposalReplies,
  type TextActionProposalVocabulary,
  mayDecideApproval,
  parseTextActionProposalCommand,
  resolveTextActionProposalDecision,
  textActionProposalReply,
} from '@dudousxd/nestjs-agent-core';
import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import type { AgentModuleOptions } from '../agent.options.js';

@Injectable()
export class ActionProposalService {
  constructor(
    @Inject(AGENT_STORE) private readonly store: AgentStore,
    @Inject(AGENT_OPTIONS)
    private readonly options: Pick<AgentModuleOptions, 'approvalPolicy' | 'actionProposalText'>,
  ) {
    const text = options.actionProposalText;
    this.vocabulary = { ...DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY, ...text?.vocabulary };
    this.replies = { ...DEFAULT_TEXT_ACTION_PROPOSAL_REPLIES, ...text?.replies };
  }
  /** The words a text decision is made of, and what the agent answers — English unless configured. */
  private readonly vocabulary: TextActionProposalVocabulary;
  private readonly replies: TextActionProposalReplies;
  private capability(): AgentStore & ActionProposalStore & ActionProposalOutcomeStore {
    const store = this.store as AgentStore & ActionProposalStore & ActionProposalOutcomeStore;
    if (
      typeof store.getThreadActionProposalScope !== 'function' ||
      typeof store.listActionProposals !== 'function'
    )
      throw new NotImplementedException('Action proposals are unavailable');
    return store;
  }
  private async scope(threadId: string, actor: Actor): Promise<ActionProposalScope> {
    const scope = await this.capability().getThreadActionProposalScope(threadId);
    if (!scope) throw new NotFoundException('Thread not found');
    if (scope.tenantRef !== (actor.tenantRef ?? null))
      throw new ForbiddenException('Wrong proposal tenant');
    return scope;
  }
  private mayDecide(
    actor: Actor,
    proposal: { originToolCallId: string; approver: string; actorRef: string },
  ) {
    return mayDecideApproval(this.options.approvalPolicy, actor, {
      toolCallId: proposal.originToolCallId,
      approver: proposal.approver,
      requesterRef: proposal.actorRef,
    });
  }
  async listPage(threadId: string, actor: Actor, query: Pick<ListActionProposals, 'after'> = {}) {
    const scope = await this.scope(threadId, actor);
    const rows = await this.capability().listActionProposals(scope, { limit: 1000, ...query });
    const visible = [];
    for (const row of rows)
      if (scope.actorRef === actor.id || (await this.mayDecide(actor, row))) visible.push(row);
    const last = rows.at(-1);
    return {
      items: visible,
      ...(rows.length === 1000 && last ? { next: { createdAt: last.createdAt, id: last.id } } : {}),
    };
  }
  async list(threadId: string, actor: Actor) {
    return (await this.listPage(threadId, actor)).items;
  }
  async decide(
    threadId: string,
    proposalId: string,
    actor: Actor,
    command: {
      decision: 'approved' | 'rejected';
      remember?: boolean;
      reason?: string;
      via?: string;
    },
  ): Promise<ActionProposalMutationResult> {
    const scope = await this.scope(threadId, actor);
    const proposal = await this.capability().getActionProposal(scope, proposalId);
    if (!proposal) throw new NotFoundException('Proposal not found');
    if (!(await this.mayDecide(actor, proposal)))
      throw new ForbiddenException('May not decide this proposal');
    return this.capability().decideActionProposal(scope, proposalId, {
      decision: command.decision,
      actorRef: actor.id,
      via: command.via ?? 'web',
      ...(command.remember !== undefined ? { remember: command.remember } : {}),
      ...(command.reason !== undefined ? { reason: command.reason } : {}),
    });
  }
  async handleTextDecision(threadId: string, actor: Actor, text: string) {
    const command = parseTextActionProposalCommand(text, this.vocabulary);
    if (command.status === 'unmatched') return command;
    if (command.proposalId !== undefined) {
      const result = await this.decide(threadId, command.proposalId, actor, {
        decision: command.decision,
        remember: command.remember,
        via: 'text',
      });
      return this.textReceipt(threadId, result, command.decision);
    }
    const candidates = [];
    const scope = await this.scope(threadId, actor);
    const pending = await this.capability().listActionProposals(scope, {
      decision: 'pending',
      limit: 1000,
    });
    for (const proposal of pending)
      if (await this.mayDecide(actor, proposal)) candidates.push(proposal);
    const resolution = resolveTextActionProposalDecision(text, candidates, this.vocabulary);
    if (resolution.status === 'unmatched') return resolution;
    // A saturated page may hide other candidates: a bare command cannot safely pick one.
    const saturated = pending.length === 1000 && !text.includes('#');
    if (resolution.status === 'ambiguous' || saturated) {
      const proposalIds = candidates.map(({ id }) => id);
      return {
        threadId,
        proposalDecision: { status: 'ambiguous' as const, proposalIds },
        text: saturated ? this.replies.tooMany : this.replies.ambiguous(proposalIds),
      };
    }
    const result = await this.decide(threadId, resolution.proposalId, actor, {
      decision: resolution.decision,
      remember: resolution.remember,
      via: 'text',
    });
    return this.textReceipt(threadId, result, resolution.decision);
  }
  private textReceipt(
    threadId: string,
    result: ActionProposalMutationResult,
    decision: 'approved' | 'rejected',
  ) {
    return { threadId, proposalDecision: result, text: this.reply(result, decision) };
  }
  /** The configured reply to a decision the store answered with `result`. */
  reply(result: ActionProposalMutationResult, decision: 'approved' | 'rejected'): string {
    return textActionProposalReply(result, decision, this.replies);
  }
}
