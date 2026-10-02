import { createHash, randomUUID } from 'node:crypto';
import {
  type ActionProposal,
  type ActionProposalDecisionCommand,
  type ActionProposalDiscoveryIndexStore,
  type ActionProposalMutationResult,
  type ActionProposalScope,
  type ActionProposalStore,
  type ActionProposalStoreOptions,
  type ActionProposalWorkerStore,
  type ClaimActionProposal,
  type CreateActionProposal,
  type CreateActionProposalResult,
  type ExtendActionProposalLease,
  type ListActionProposals,
  type SettleActionProposal,
  actionProposalScopeMatches,
  canonicalActionProposalJson,
  initialActionProposal,
  transitionActionProposalClaim,
  transitionActionProposalDecision,
  transitionActionProposalLease,
  transitionActionProposalSettlement,
  validateActionProposalDiscoveryIndexBatch,
  validateActionProposalExpiryBatch,
  validateActionProposalListQuery,
  validateActionProposalWorkerClaim,
} from '@dudousxd/nestjs-agent-core';
import { and, asc, eq, lte, or } from 'drizzle-orm';
import {
  type AgentDialect,
  type AgentDrizzleDb,
  type AgentSqliteDb,
  type AgentTables,
  affectedRows,
  agentDialectOf,
  agentTablesFor,
  asBuilder,
  mysqlAffectedRows,
} from './dialect.js';

interface MySqlInsertIgnore<Row> {
  ignore(): { values(value: Row): PromiseLike<unknown> };
}

type ProposalRow = AgentTables['agentActionProposal']['$inferSelect'];

/**
 * Independent persisted proposals. Each decision and its durable execution work live in one row;
 * a version predicate fences every read/modify/write across connections and store instances.
 */
export class DrizzleActionProposalStore
  implements ActionProposalStore, ActionProposalWorkerStore, ActionProposalDiscoveryIndexStore
{
  private readonly db: AgentSqliteDb;
  private readonly dialect: AgentDialect;
  private readonly table: AgentTables['agentActionProposal'];
  private readonly clock: () => number;

  constructor(db: AgentDrizzleDb, options: ActionProposalStoreOptions = {}) {
    this.dialect = agentDialectOf(db);
    this.table = agentTablesFor(this.dialect).agentActionProposal;
    this.db = asBuilder(db);
    this.clock = options.clock ?? Date.now;
  }

  async createActionProposal(input: CreateActionProposal): Promise<CreateActionProposalResult> {
    const proposal = initialActionProposal(input, this.clock());
    const row = {
      id: physicalId(input.id),
      scopeKey: scopeKey(input),
      decision: proposal.decision,
      logicalSort: logicalSort(input.id),
      createFingerprint: canonicalActionProposalJson(input),
      proposal,
      ...discoveryMetadata(proposal),
      version: 0,
      createdAt: proposal.createdAt,
    };
    const table = this.table;
    const insert = this.db.insert(table);
    const inserted =
      this.dialect === 'mysql'
        ? mysqlAffectedRows(
            await (insert as unknown as MySqlInsertIgnore<typeof row>).ignore().values(row),
          )
        : await affectedRows(this.dialect, insert.values(row).onConflictDoNothing(), table.id);
    const stored = await this.read(input, input.id);
    if (!stored) return { status: 'conflict' };
    if (inserted === 1) return { status: 'created', proposal: stored.proposal };
    return {
      status: stored.createFingerprint === row.createFingerprint ? 'unchanged' : 'conflict',
      proposal: stored.proposal,
    };
  }

  async getActionProposal(scope: ActionProposalScope, id: string): Promise<ActionProposal | null> {
    return (await this.read(scope, id))?.proposal ?? null;
  }

  async listActionProposals(
    scope: ActionProposalScope,
    query: ListActionProposals = {},
  ): Promise<ActionProposal[]> {
    const limit = validateActionProposalListQuery(query);
    const rows = await this.db
      .select()
      .from(this.table)
      .where(
        and(
          eq(this.table.scopeKey, scopeKey(scope)),
          query.decision === undefined ? undefined : eq(this.table.decision, query.decision),
        ),
      )
      .orderBy(asc(this.table.createdAt), asc(this.table.logicalSort))
      .limit(limit);
    return rows
      .map((row) => row.proposal)
      .filter((proposal) => actionProposalScopeMatches(proposal, scope));
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
    const table = this.table;
    const candidates = await this.db
      .select()
      .from(table)
      .where(
        and(
          eq(table.discoveryIndexVersion, 1),
          eq(table.decision, 'approved'),
          or(
            eq(table.executionStatus, 'queued'),
            and(eq(table.executionStatus, 'executing'), lte(table.leaseExpiresAt, now)),
          ),
        ),
      )
      .orderBy(asc(table.createdAt), asc(table.logicalSort))
      .limit(32);
    for (const candidate of candidates) {
      const result = await this.claimActionProposal(
        candidate.proposal,
        candidate.proposal.id,
        command,
      );
      if (result.status === 'applied' && result.proposal) return result.proposal;
    }
    return null;
  }

  async expireActionProposals(command: { limit: number }): Promise<number> {
    const now = this.clock();
    validateActionProposalExpiryBatch(command, now);
    const table = this.table;
    const candidates = await this.db
      .select()
      .from(table)
      .where(
        and(
          eq(table.discoveryIndexVersion, 1),
          eq(table.decision, 'pending'),
          lte(table.proposalExpiresAt, now),
        ),
      )
      .orderBy(asc(table.createdAt), asc(table.logicalSort))
      .limit(command.limit);
    let expired = 0;
    for (const candidate of candidates) {
      const result = await this.decideActionProposal(candidate.proposal, candidate.proposal.id, {
        decision: 'expired',
        actorRef: 'system',
        via: 'expiry',
      });
      if (result.status === 'applied') expired++;
    }
    return expired;
  }

  async backfillActionProposalDiscoveryIndex(command: { limit: number }): Promise<number> {
    validateActionProposalDiscoveryIndexBatch(command);
    const table = this.table;
    const candidates = await this.db
      .select()
      .from(table)
      .where(eq(table.discoveryIndexVersion, 0))
      .orderBy(asc(table.createdAt), asc(table.logicalSort))
      .limit(command.limit);
    let changed = 0;
    for (const row of candidates) {
      changed += await affectedRows(
        this.dialect,
        this.db
          .update(table)
          .set({
            ...discoveryMetadata(row.proposal),
            version: row.version + 1,
          })
          .where(
            and(
              eq(table.id, row.id),
              eq(table.scopeKey, row.scopeKey),
              eq(table.version, row.version),
              eq(table.discoveryIndexVersion, 0),
            ),
          ),
        table.id,
      );
    }
    return changed;
  }

  private async read(scope: ActionProposalScope, id: string): Promise<ProposalRow | undefined> {
    const [row] = await this.db
      .select()
      .from(this.table)
      .where(and(eq(this.table.id, physicalId(id)), eq(this.table.scopeKey, scopeKey(scope))))
      .limit(1);
    return row && row.proposal.id === id && actionProposalScopeMatches(row.proposal, scope)
      ? row
      : undefined;
  }

  private async mutate(
    scope: ActionProposalScope,
    id: string,
    transition: (proposal: ActionProposal, now: number) => ActionProposalMutationResult,
  ): Promise<ActionProposalMutationResult> {
    // A caller repeatable-read transaction may retain its original snapshot after losing CAS.
    // Bound retries so that transaction returns a conflict instead of spinning indefinitely.
    for (let attempt = 0; attempt < 32; attempt++) {
      const row = await this.read(scope, id);
      if (!row) return { status: 'not_found' };
      // Recompute the trusted clock after every lost CAS, so a delayed retry cannot approve or
      // settle a proposal using the time observed before another writer advanced it.
      const result = transition(row.proposal, this.clock());
      if (
        !result.proposal ||
        canonicalActionProposalJson(result.proposal) === canonicalActionProposalJson(row.proposal)
      )
        return result;
      const changed = await affectedRows(
        this.dialect,
        this.db
          .update(this.table)
          .set({
            proposal: result.proposal,
            decision: result.proposal.decision,
            ...discoveryMetadata(result.proposal),
            version: row.version + 1,
          })
          .where(
            and(
              eq(this.table.id, physicalId(id)),
              eq(this.table.scopeKey, scopeKey(scope)),
              eq(this.table.version, row.version),
            ),
          ),
        this.table.id,
      );
      // Return this operation's winning fence, never a peer's later recovery token.
      if (changed === 1) return result;
    }
    const row = await this.read(scope, id);
    return row ? { status: 'conflict', proposal: row.proposal } : { status: 'not_found' };
  }
}

function scopeKey(scope: ActionProposalScope): string {
  return createHash('sha256')
    .update(canonicalActionProposalJson([scope.tenantRef, scope.actorRef, scope.threadId]))
    .digest('hex');
}

function physicalId(id: string): string {
  return createHash('sha256').update(canonicalActionProposalJson(id)).digest('hex');
}

/** Hex UTF16 code units preserve the core's JavaScript lexical ID order in every SQL dialect. */
function logicalSort(id: string): string {
  let sort = '';
  for (let index = 0; index < id.length; index++)
    sort += id.charCodeAt(index).toString(16).padStart(4, '0');
  return sort;
}

function discoveryMetadata(proposal: ActionProposal) {
  return {
    executionStatus: proposal.execution?.status ?? null,
    leaseExpiresAt: proposal.execution?.lease?.expiresAt ?? null,
    proposalExpiresAt: proposal.expiresAt,
    discoveryIndexVersion: 1,
  };
}
