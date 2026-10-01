import { createHash, randomUUID } from 'node:crypto';
import {
  type ActionProposal,
  type ActionProposalDecisionCommand,
  type ActionProposalMutationResult,
  type ActionProposalScope,
  type ActionProposalStore,
  type ActionProposalStoreOptions,
  type ClaimActionProposal,
  type CreateActionProposal,
  type CreateActionProposalResult,
  type ExtendActionProposalLease,
  type ListActionProposals,
  type SettleActionProposal,
  actionProposalCreationMatches,
  actionProposalScopeMatches,
  canonicalActionProposalJson,
  initialActionProposal,
  snapshotActionProposal,
  transitionActionProposalClaim,
  transitionActionProposalDecision,
  transitionActionProposalLease,
  transitionActionProposalSettlement,
  validateActionProposalListQuery,
} from '@dudousxd/nestjs-agent-core';
import type { EntityManager } from '@mikro-orm/core';
import { AgentActionProposal } from './entities/agent-action-proposal.entity';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const idKey = (id: string) => digest(canonicalActionProposalJson(id));
const scopeKey = (scope: ActionProposalScope) =>
  digest(canonicalActionProposalJson([scope.tenantRef, scope.actorRef, scope.threadId]));
const sortKey = (id: string) =>
  Array.from({ length: id.length }, (_, index) =>
    id.charCodeAt(index).toString(16).padStart(4, '0'),
  ).join('');

/** Internal adapter delegated to by MikroOrmAgentStore; no second DI provider or AgentStore SPI. */
export class MikroOrmActionProposals implements ActionProposalStore {
  private readonly clock: () => number;
  constructor(
    private readonly em: EntityManager,
    options: ActionProposalStoreOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
  }

  async createActionProposal(input: CreateActionProposal): Promise<CreateActionProposalResult> {
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
        `insert into agent_action_proposal (id, scope_key, insertion_token, sort_key, payload, revision, decision, execution_status, lease_expires_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ${duplicate}`,
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
          decision: next.decision,
          executionStatus: next.execution?.status ?? null,
          leaseExpiresAt: next.execution?.lease?.expiresAt ?? null,
        },
      );
      if (touched === 1) return outcome;
    }
    // REPEATABLE READ can retain an old snapshot after losing a current-row CAS. Bound retries
    // so a caller transaction returns a conflict instead of waiting forever on its own snapshot.
    return {
      status: 'conflict',
      ...(lastObserved === undefined ? {} : { proposal: snapshotActionProposal(lastObserved) }),
    };
  }
}
