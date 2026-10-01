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
  actionProposalScopeMatches,
  canonicalActionProposalJson,
  initialActionProposal,
  transitionActionProposalClaim,
  transitionActionProposalDecision,
  transitionActionProposalLease,
  transitionActionProposalSettlement,
  validateActionProposalListQuery,
} from '@dudousxd/nestjs-agent-core';
import { and, asc, eq } from 'drizzle-orm';
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
export class DrizzleActionProposalStore implements ActionProposalStore {
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
