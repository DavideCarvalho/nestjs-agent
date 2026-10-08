import { createHash, randomUUID } from 'node:crypto';
import {
  type ActionProposal,
  type ActionProposalDecisionCommand,
  type ActionProposalDiscoveryIndexStore,
  type ActionProposalMutationResult,
  type ActionProposalOutcomeLease,
  type ActionProposalOutcomeStore,
  type ActionProposalScope,
  type ActionProposalStore,
  type ActionProposalStoreOptions,
  type ActionProposalSupersessionStore,
  type ActionProposalWorkerStore,
  type ClaimActionProposal,
  type CreateActionProposal,
  type CreateActionProposalResult,
  type ExtendActionProposalLease,
  type ListActionProposals,
  type SettleActionProposal,
  actionProposalCreationMatches,
  actionProposalOutcomeFenceValid,
  actionProposalOutcomeText,
  actionProposalScopeMatches,
  canonicalActionProposalJson,
  claimActionProposalOutcome,
  initialActionProposal,
  snapshotActionProposal,
  toolCallUpdateForTransition,
  transitionActionProposalClaim,
  transitionActionProposalDecision,
  transitionActionProposalLease,
  transitionActionProposalSettlement,
  transitionActionProposalSupersession,
  validateActionProposalDiscoveryIndexBatch,
  validateActionProposalExpiryBatch,
  validateActionProposalListQuery,
  validateActionProposalWorkerClaim,
} from '@dudousxd/nestjs-agent-core';
import { LockMode, QueryOrder } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/core';
import { AgentActionProposal } from './entities/agent-action-proposal.entity';
import { AgentMessage } from './entities/agent-message.entity';
import { AgentThread } from './entities/agent-thread.entity';
import { AgentToolCall } from './entities/agent-tool-call.entity';
import { coordinateSqliteWrite } from './sqlite-write-coordinator';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const idKey = (id: string) => digest(canonicalActionProposalJson(id));
const scopeKey = (scope: ActionProposalScope) =>
  digest(canonicalActionProposalJson([scope.tenantRef, scope.actorRef, scope.threadId]));
const replacementGroupKey = (proposal: Pick<ActionProposal, 'toolName' | 'replacementKey'>) =>
  proposal.replacementKey === undefined
    ? null
    : digest(canonicalActionProposalJson([proposal.toolName, proposal.replacementKey]));
const sortKey = (id: string) =>
  Array.from({ length: id.length }, (_, index) =>
    id.charCodeAt(index).toString(16).padStart(4, '0'),
  ).join('');

/** Internal adapter delegated to by MikroOrmAgentStore; no second DI provider or AgentStore SPI. */
export class MikroOrmActionProposals
  implements
    ActionProposalStore,
    ActionProposalWorkerStore,
    ActionProposalDiscoveryIndexStore,
    ActionProposalOutcomeStore,
    ActionProposalSupersessionStore
{
  private readonly clock: () => number;
  constructor(
    private readonly em: EntityManager,
    options: ActionProposalStoreOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
  }

  async createActionProposal(input: CreateActionProposal): Promise<CreateActionProposalResult> {
    return coordinateSqliteWrite(this.em, () => this.createAttempt(input));
  }
  private async createAttempt(input: CreateActionProposal): Promise<CreateActionProposalResult> {
    const proposal = initialActionProposal(input, this.clock());
    const insertionToken = randomUUID();
    const data = {
      id: idKey(input.id),
      scopeKey: scopeKey(input),
      sortKey: sortKey(input.id),
      payload: proposal,
      revision: 0,
      decision: 'pending' as const,
      executionStatus: null,
      leaseExpiresAt: null,
      createdAt: proposal.createdAt,
    };
    // An ignored uniqueness conflict does not poison a PostgreSQL transaction. All initial data
    // lands in one insert; a globally reused id with another scope is never disclosed.
    const platform = this.em.getPlatform().constructor.name.toLowerCase();
    const duplicate =
      platform.includes('mysql') || platform.includes('maria')
        ? 'on duplicate key update id = id'
        : 'on conflict (id) do nothing';
    const em = this.em.fork({ keepTransactionContext: true });
    await em
      .getConnection()
      .execute(
        `insert into agent_action_proposal (id, scope_key, insertion_token, sort_key, payload, revision, decision, execution_status, lease_expires_at, proposal_expires_at, discovery_index_version, replacement_group_key, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ${duplicate}`,
        [
          data.id,
          data.scopeKey,
          insertionToken,
          data.sortKey,
          canonicalActionProposalJson(proposal),
          0,
          'pending',
          null,
          null,
          proposal.expiresAt,
          1,
          replacementGroupKey(proposal),
          proposal.createdAt,
        ],
        'run',
        em.getTransactionContext(),
      );
    const row = await this.em
      .fork({ keepTransactionContext: true })
      .findOne(AgentActionProposal, { id: data.id });
    if (row === null) throw new Error('Action proposal insert did not persist a row');
    if (!actionProposalScopeMatches(row.payload, input)) return { status: 'conflict' };
    if (!actionProposalCreationMatches(row.payload, input))
      return { status: 'conflict', proposal: snapshotActionProposal(row.payload) };
    // MySQL FOUND_ROWS may count a duplicate no-op update as one. The insert-only marker
    // identifies the creator independently of affected-row counts and trusted-clock precision.
    return {
      status: row.insertionToken === insertionToken ? 'created' : 'unchanged',
      proposal: snapshotActionProposal(row.payload),
    };
  }

  async getActionProposal(scope: ActionProposalScope, id: string): Promise<ActionProposal | null> {
    const row = await this.load(scope, id);
    return row === null ? null : snapshotActionProposal(row.payload);
  }
  async listActionProposals(
    scope: ActionProposalScope,
    query: ListActionProposals = {},
  ): Promise<ActionProposal[]> {
    const limit = validateActionProposalListQuery(query);
    const rows = await this.em.fork({ keepTransactionContext: true }).find(
      AgentActionProposal,
      {
        scopeKey: scopeKey(scope),
        ...(query.decision === undefined ? {} : { decision: query.decision }),
        ...(query.after === undefined
          ? {}
          : {
              $or: [
                { createdAt: { $gt: query.after.createdAt } },
                { createdAt: query.after.createdAt, sortKey: { $gt: sortKey(query.after.id) } },
              ],
            }),
      },
      { limit, orderBy: { createdAt: 'asc', sortKey: 'asc' } },
    );
    return rows
      .filter((row) => actionProposalScopeMatches(row.payload, scope))
      .map((row) => snapshotActionProposal(row.payload));
  }
  decideActionProposal(
    scope: ActionProposalScope,
    id: string,
    command: ActionProposalDecisionCommand,
  ): Promise<ActionProposalMutationResult> {
    return this.mutate(scope, id, (row, now) =>
      transitionActionProposalDecision(row, command, now),
    );
  }
  claimActionProposal(
    scope: ActionProposalScope,
    id: string,
    command: ClaimActionProposal,
  ): Promise<ActionProposalMutationResult> {
    return this.mutate(scope, id, (row, now) =>
      transitionActionProposalClaim(row, command, now, randomUUID()),
    );
  }
  extendActionProposalLease(
    scope: ActionProposalScope,
    id: string,
    command: ExtendActionProposalLease,
  ): Promise<ActionProposalMutationResult> {
    return this.mutate(scope, id, (row, now) => transitionActionProposalLease(row, command, now));
  }
  settleActionProposal(
    scope: ActionProposalScope,
    id: string,
    command: SettleActionProposal,
  ): Promise<ActionProposalMutationResult> {
    return this.mutate(scope, id, (row, now) =>
      transitionActionProposalSettlement(row, command, now),
    );
  }
  async claimNextActionProposal(command: ClaimActionProposal): Promise<ActionProposal | null> {
    const now = this.clock();
    validateActionProposalWorkerClaim(command, now);
    const candidates = await this.em.fork({ keepTransactionContext: true }).find(
      AgentActionProposal,
      {
        discoveryIndexVersion: 1,
        decision: 'approved',
        $or: [
          { executionStatus: 'queued' },
          { executionStatus: 'executing', leaseExpiresAt: { $lte: now } },
        ],
      },
      { limit: 32, orderBy: { createdAt: 'asc', sortKey: 'asc' } },
    );
    for (const candidate of candidates) {
      const outcome = await this.claimActionProposal(
        candidate.payload,
        candidate.payload.id,
        command,
      );
      if (outcome.status === 'applied' && outcome.proposal) return outcome.proposal;
    }
    return null;
  }

  async expireActionProposals(command: { limit: number }): Promise<number> {
    const now = this.clock();
    validateActionProposalExpiryBatch(command, now);
    const candidates = await this.em.fork({ keepTransactionContext: true }).find(
      AgentActionProposal,
      {
        discoveryIndexVersion: 1,
        decision: 'pending',
        proposalExpiresAt: { $lte: now },
      },
      { limit: command.limit, orderBy: { createdAt: 'asc', sortKey: 'asc' } },
    );
    let expired = 0;
    for (const candidate of candidates) {
      const outcome = await this.decideActionProposal(candidate.payload, candidate.payload.id, {
        decision: 'expired',
        actorRef: 'system',
        via: 'expiry',
      });
      if (outcome.status === 'applied') expired++;
    }
    return expired;
  }

  /** Explicit bounded deployment maintenance; never changes the proposal snapshot or audit. */
  async backfillActionProposalDiscoveryIndex(command: { limit: number }): Promise<number> {
    validateActionProposalDiscoveryIndexBatch(command);
    const candidates = await this.em
      .fork({ keepTransactionContext: true })
      .find(
        AgentActionProposal,
        { discoveryIndexVersion: 0 },
        { limit: command.limit, orderBy: { createdAt: 'asc', sortKey: 'asc' } },
      );
    let updated = 0;
    for (const candidate of candidates) {
      const touched = await this.em.fork({ keepTransactionContext: true }).nativeUpdate(
        AgentActionProposal,
        {
          id: candidate.id,
          scopeKey: candidate.scopeKey,
          revision: candidate.revision,
          discoveryIndexVersion: 0,
        },
        { ...discoveryProjection(candidate.payload), revision: candidate.revision + 1 },
      );
      if (touched === 1) updated++;
    }
    return updated;
  }

  async rememberedActionProposals(scope: ActionProposalScope): Promise<ActionProposal[]> {
    const rows = await this.em.fork({ keepTransactionContext: true }).find(AgentActionProposal, {
      scopeKey: scopeKey(scope),
      decision: 'approved',
      executionStatus: { $in: ['succeeded', 'failed'] },
    });
    return rows
      .map((row) => row.payload)
      .filter(
        (proposal) =>
          actionProposalScopeMatches(proposal, scope) && proposal.decisionAudit?.remember === true,
      );
  }
  async getThreadActionProposalScope(threadId: string): Promise<ActionProposalScope | null> {
    const thread = await this.em
      .fork({ keepTransactionContext: true })
      .findOne(AgentThread, { id: threadId, deletedAt: null });
    return thread?.id === threadId
      ? { threadId, actorRef: thread.actorRef, tenantRef: thread.tenantRef ?? null }
      : null;
  }
  async claimNextActionProposalOutcome(
    command: ClaimActionProposal,
  ): ReturnType<ActionProposalOutcomeStore['claimNextActionProposalOutcome']> {
    const now = this.clock();
    validateActionProposalWorkerClaim(command, now);
    const candidates = await this.em.fork({ keepTransactionContext: true }).find(
      AgentActionProposal,
      {
        deliveryStatus: 'pending',
        $or: [{ deliveryLeaseExpiresAt: null }, { deliveryLeaseExpiresAt: { $lte: now } }],
      },
      { limit: 32, orderBy: { createdAt: 'asc', sortKey: 'asc' } },
    );
    for (const row of candidates) {
      const claimed = await this.mutate(row.payload, row.payload.id, (proposal, time) => {
        const next = claimActionProposalOutcome(proposal, command, time, randomUUID());
        return next ? { status: 'applied', proposal: next } : { status: 'conflict', proposal };
      });
      const proposal = claimed.proposal;
      if (claimed.status === 'applied' && proposal?.outcome && proposal.outcomeDelivery?.lease)
        return {
          outcome: proposal.outcome,
          lease: {
            outcomeId: proposal.outcome.id,
            token: proposal.outcomeDelivery.lease.token,
            generation: proposal.outcomeDelivery.generation,
          },
        };
    }
    return null;
  }
  async admitActionProposalOutcome(
    command: ActionProposalOutcomeLease,
  ): ReturnType<ActionProposalOutcomeStore['admitActionProposalOutcome']> {
    for (let attempt = 0; attempt < 32; attempt++)
      try {
        return await coordinateSqliteWrite(this.em, () => this.admitOutcomeAttempt(command));
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !/database is locked|SQLITE_BUSY/.test(error.message) ||
          attempt === 31
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(attempt + 1, 10)));
      }
    throw new Error('Outcome admission contention exhausted');
  }
  private async admitOutcomeAttempt(
    command: ActionProposalOutcomeLease,
  ): ReturnType<ActionProposalOutcomeStore['admitActionProposalOutcome']> {
    const em = this.em.fork({ keepTransactionContext: true });
    return em.transactional(async (tx) => {
      const sqlite = tx.getPlatform().constructor.name.toLowerCase().includes('sqlite');
      if (sqlite)
        await tx
          .getConnection()
          .execute(
            'update agent_action_proposal set revision = revision where outcome_id_key = ?',
            [idKey(command.outcomeId)],
            'run',
            tx.getTransactionContext(),
          );
      const row = await tx.findOne(
        AgentActionProposal,
        { outcomeIdKey: idKey(command.outcomeId) },
        sqlite ? {} : { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (
        !row?.payload.outcome ||
        row.payload.outcome.id !== command.outcomeId ||
        !row.payload.outcomeDelivery
      )
        return { status: 'not_found' };
      const proposal = row.payload;
      const delivery = proposal.outcomeDelivery;
      const outcome = proposal.outcome;
      if (!delivery || !outcome) return { status: 'not_found' };
      if (delivery.status === 'admitted')
        return {
          status: 'unchanged',
          ...(delivery.messageId !== undefined ? { messageId: delivery.messageId } : {}),
        };
      if (delivery.status === 'discarded') return { status: 'discarded' };
      const thread = await tx.findOne(
        AgentThread,
        { id: proposal.threadId },
        sqlite ? {} : { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!actionProposalOutcomeFenceValid(proposal, command, this.clock()))
        return { status: 'conflict' };
      if (
        thread &&
        !thread.deletedAt &&
        (thread.id !== proposal.threadId ||
          thread.actorRef !== proposal.actorRef ||
          (thread.tenantRef ?? null) !== proposal.tenantRef)
      )
        return { status: 'conflict' };
      if (thread && !thread.deletedAt && thread.activeStreamId) return { status: 'busy' };
      if (!thread || thread.deletedAt) {
        const next = snapshotActionProposal({
          ...proposal,
          outcomeDelivery: { ...delivery, status: 'discarded' as const, lease: null },
        });
        await tx.nativeUpdate(
          AgentActionProposal,
          { id: row.id, scopeKey: row.scopeKey, revision: row.revision },
          { payload: next, revision: row.revision + 1, ...discoveryProjection(next) },
        );
        return { status: 'discarded' };
      }
      const last = await tx.findOne(
        AgentMessage,
        { thread: thread.id },
        { orderBy: { seq: QueryOrder.DESC }, fields: ['seq'] },
      );
      const messageId = randomUUID();
      const message = tx.create(AgentMessage, {
        id: messageId,
        thread,
        role: 'assistant',
        content: actionProposalOutcomeText(outcome),
        actionProposalOutcome: canonicalActionProposalJson(proposal.outcome),
        seq: (last?.seq ?? 0) + 1,
        createdAt: new Date(this.clock()),
        ui: null,
      });
      tx.persist(message);
      thread.updatedAt = message.createdAt;
      await tx.flush();
      const next = snapshotActionProposal({
        ...proposal,
        outcomeDelivery: { ...delivery, status: 'admitted' as const, lease: null, messageId },
      });
      const touched = await tx.nativeUpdate(
        AgentActionProposal,
        { id: row.id, scopeKey: row.scopeKey, revision: row.revision },
        { payload: next, revision: row.revision + 1, ...discoveryProjection(next) },
      );
      if (touched !== 1) throw new Error('Action proposal admission CAS lost');
      return { status: 'applied', messageId };
    });
  }
  async createReplacingActionProposal(
    input: CreateActionProposal,
  ): Promise<CreateActionProposalResult> {
    return coordinateSqliteWrite(this.em, () => this.createReplacingAttempt(input));
  }
  private async createReplacingAttempt(
    input: CreateActionProposal,
  ): Promise<CreateActionProposalResult> {
    const em = this.em.fork({ keepTransactionContext: true });
    return em.transactional(async (tx) => {
      const sqlite = tx.getPlatform().constructor.name.toLowerCase().includes('sqlite');
      if (sqlite)
        await tx
          .getConnection()
          .execute(
            'update agent_thread set updated_at = updated_at where id = ?',
            [input.threadId],
            'run',
            tx.getTransactionContext(),
          );
      const thread = await tx.findOne(
        AgentThread,
        { id: input.threadId, deletedAt: null },
        sqlite ? {} : { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (
        !thread ||
        thread.id !== input.threadId ||
        thread.actorRef !== input.actorRef ||
        (thread.tenantRef ?? null) !== input.tenantRef
      )
        return { status: 'conflict' };
      const helper = new MikroOrmActionProposals(tx, { clock: this.clock });
      const created = await helper.createActionProposal(input);
      if (created.status !== 'created' || !created.proposal || !input.replacementKey)
        return created;
      const rows = await tx.find(
        AgentActionProposal,
        {
          scopeKey: scopeKey(input),
          replacementGroupKey: replacementGroupKey(input),
          decision: 'pending',
        },
        sqlite ? {} : { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      for (const row of rows) {
        if (
          row.payload.id === input.id ||
          row.payload.toolName !== input.toolName ||
          row.payload.replacementKey !== input.replacementKey
        )
          continue;
        await helper.supersedeActionProposal(input, row.payload.id, {
          replacementProposalId: input.id,
          actorRef: input.actorRef,
          via: 'supersession',
        });
      }
      return created;
    });
  }
  async supersedeActionProposal(
    scope: ActionProposalScope,
    id: string,
    command: { replacementProposalId: string; actorRef: string; via: string },
  ): Promise<ActionProposalMutationResult> {
    const replacement = await this.getActionProposal(scope, command.replacementProposalId);
    if (!replacement) return { status: 'not_found' };
    return this.mutate(scope, id, (row, now) =>
      transitionActionProposalSupersession(row, replacement, command, now),
    );
  }
  /**
   * The proposal's `proposed` tool-call record follows the transition just written — in the caller's
   * transaction when there is one — so the dashboard and run detail show `executed` / `failed` /
   * `rejected` / `expired` rather than `proposed` forever.
   */
  private async settleToolCall(previous: ActionProposal, next: ActionProposal): Promise<void> {
    const update = toolCallUpdateForTransition(previous, next);
    if (update === null) return;
    await this.em.fork({ keepTransactionContext: true }).nativeUpdate(
      AgentToolCall,
      { id: update.toolCallId, proposalId: next.id },
      {
        status: update.status,
        ...(update.output !== undefined ? { output: update.output } : {}),
        ...(update.error !== undefined ? { error: update.error } : {}),
        ...(update.executedByRef !== undefined ? { executedByRef: update.executedByRef } : {}),
        ...(update.decidedVia !== undefined ? { decidedVia: update.decidedVia } : {}),
        ...(update.remember !== undefined ? { remember: update.remember } : {}),
        ...(update.status === 'executed' ? { executedAt: new Date(this.clock()) } : {}),
      },
    );
  }
  private async load(scope: ActionProposalScope, id: string): Promise<AgentActionProposal | null> {
    const row = await this.em
      .fork({ keepTransactionContext: true })
      .findOne(AgentActionProposal, { id: idKey(id), scopeKey: scopeKey(scope) });
    return row !== null && row.payload.id === id && actionProposalScopeMatches(row.payload, scope)
      ? row
      : null;
  }
  private async mutate(
    scope: ActionProposalScope,
    id: string,
    transition: (row: ActionProposal, now: number) => ActionProposalMutationResult,
  ): Promise<ActionProposalMutationResult> {
    return coordinateSqliteWrite(this.em, () => this.mutateAttempt(scope, id, transition));
  }
  private async mutateAttempt(
    scope: ActionProposalScope,
    id: string,
    transition: (row: ActionProposal, now: number) => ActionProposalMutationResult,
  ): Promise<ActionProposalMutationResult> {
    let lastObserved: ActionProposal | undefined;
    for (let attempt = 0; attempt < 32; attempt++) {
      const row = await this.load(scope, id);
      if (row === null) return { status: 'not_found' };
      lastObserved = row.payload;
      const outcome = transition(row.payload, this.clock());
      if (
        outcome.proposal === undefined ||
        canonicalActionProposalJson(outcome.proposal) === canonicalActionProposalJson(row.payload)
      )
        return outcome;
      const next = outcome.proposal;
      // Approval AND embedded queued work are one row update, fenced by the observed revision.
      // A competing writer wins only once; a loser reloads and rechecks the trusted clock/state.
      const touched = await this.em.fork({ keepTransactionContext: true }).nativeUpdate(
        AgentActionProposal,
        { id: row.id, scopeKey: row.scopeKey, revision: row.revision },
        {
          payload: next,
          revision: row.revision + 1,
          ...discoveryProjection(next),
        },
      );
      if (touched === 1) {
        await this.settleToolCall(row.payload, next);
        return outcome;
      }
    }
    // REPEATABLE READ can retain an old snapshot after losing a current-row CAS. Bound retries
    // so a caller transaction returns a conflict instead of waiting forever on its own snapshot.
    return {
      status: 'conflict',
      ...(lastObserved === undefined ? {} : { proposal: snapshotActionProposal(lastObserved) }),
    };
  }
}

function discoveryProjection(proposal: ActionProposal) {
  return {
    decision: proposal.decision,
    replacementGroupKey: replacementGroupKey(proposal),
    deliveryStatus: proposal.outcomeDelivery?.status ?? null,
    deliveryLeaseExpiresAt: proposal.outcomeDelivery?.lease?.expiresAt ?? null,
    outcomeIdKey: proposal.outcome ? idKey(proposal.outcome.id) : null,
    executionStatus: proposal.execution?.status ?? null,
    leaseExpiresAt: proposal.execution?.lease?.expiresAt ?? null,
    proposalExpiresAt: proposal.expiresAt,
    discoveryIndexVersion: 1,
  };
}
