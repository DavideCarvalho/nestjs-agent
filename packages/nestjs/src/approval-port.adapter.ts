import type { Actor, AgentApprovalPort } from '@dudousxd/nestjs-agent-core';
import { Injectable, NotImplementedException, Optional } from '@nestjs/common';
import { AgentService } from './agent.service.js';
import { ActionProposalService } from './proposals/action-proposal.service.js';

/**
 * Binds `AGENT_APPROVAL_PORT` for the console's cross-thread approvals inbox to the SAME decision
 * path chat approvals use — `AgentService.signalToolCall` (resolve the run awaiting `toolCallId`,
 * then `AgentRunner.signal`, which is either the inline pending-promise map or the durable signal
 * `tool:<runId>:<callId>`, depending on how the host configured `AgentModule`).
 *
 * Deliberately WITHOUT `AgentService.approve`/`reject`'s ownership check: a console caller reaches
 * this port only through the dashboard's own guards (already authorized), not as the thread's own
 * actor — re-deriving "does this actor own the thread" here would reject a legitimate operator
 * decision. `opts.executedByRef` is an OPAQUE decider ref, not re-authorized against anything: it
 * rides the `Decision` and the loop records it as the tool call's decider
 * (`decision.executedByRef ?? input.actor.id`, on both the executed and rejected paths).
 */
@Injectable()
export class AgentApprovalPortAdapter implements AgentApprovalPort {
  constructor(
    private readonly agent: AgentService,
    @Optional() private readonly proposals?: ActionProposalService,
  ) {}
  async approveActionProposal(
    actor: Actor,
    target: { kind: 'proposal'; threadId: string; proposalId: string },
    opts?: { remember?: boolean; decidedVia?: string },
  ) {
    if (!this.proposals) throw new NotImplementedException('Action proposals unavailable');
    return this.proposals.decide(target.threadId, target.proposalId, actor, {
      decision: 'approved',
      ...(opts?.remember !== undefined ? { remember: opts.remember } : {}),
      via: opts?.decidedVia ?? 'console',
    });
  }
  async rejectActionProposal(
    actor: Actor,
    target: { kind: 'proposal'; threadId: string; proposalId: string },
    opts?: { reason?: string; decidedVia?: string },
  ) {
    if (!this.proposals) throw new NotImplementedException('Action proposals unavailable');
    return this.proposals.decide(target.threadId, target.proposalId, actor, {
      decision: 'rejected',
      ...(opts?.reason !== undefined ? { reason: opts.reason } : {}),
      via: opts?.decidedVia ?? 'console',
    });
  }

  async approve(
    toolCallId: string,
    opts?: { executedByRef?: string; remember?: boolean; decidedVia?: string },
  ): Promise<void> {
    await this.agent.signalToolCall(toolCallId, {
      approved: true,
      ...(opts?.executedByRef !== undefined ? { executedByRef: opts.executedByRef } : {}),
      ...(opts?.remember === true ? { remember: true } : {}),
      ...(opts?.decidedVia !== undefined ? { decidedVia: opts.decidedVia } : {}),
    });
  }

  async reject(
    toolCallId: string,
    opts?: { executedByRef?: string; reason?: string; decidedVia?: string },
  ): Promise<void> {
    await this.agent.signalToolCall(toolCallId, {
      approved: false,
      ...(opts?.executedByRef !== undefined ? { executedByRef: opts.executedByRef } : {}),
      ...(opts?.reason !== undefined ? { reason: opts.reason } : {}),
      ...(opts?.decidedVia !== undefined ? { decidedVia: opts.decidedVia } : {}),
    });
  }
}
