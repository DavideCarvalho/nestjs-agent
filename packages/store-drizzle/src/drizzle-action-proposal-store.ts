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
  actionProposalOutcomeFenceValid,
  actionProposalOutcomeText,
  actionProposalScopeMatches,
  canonicalActionProposalJson,
  claimActionProposalOutcome,
  initialActionProposal,
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
import { and, asc, entityKind, eq, gt, isNull, lte, max, or, sql } from 'drizzle-orm';
import { actionProposalTransactionMode } from './action-proposal-transaction-mode.js';
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
  implements
    ActionProposalStore,
    ActionProposalWorkerStore,
    ActionProposalDiscoveryIndexStore,
    ActionProposalSupersessionStore
{
  private readonly db: AgentSqliteDb;
  private readonly rawDb: AgentDrizzleDb;
  readonly actionProposalAdmissionSupported: boolean;
  private readonly synchronousSqlite: boolean;
  private readonly dialect: AgentDialect;
  private readonly table: AgentTables['agentActionProposal'];
  private readonly clock: () => number;

  constructor(db: AgentDrizzleDb, options: ActionProposalStoreOptions = {}) {
    this.rawDb = db;
    const kind = (db.constructor as unknown as Record<symbol, string>)[entityKind];
    const transactionMode = actionProposalTransactionMode(kind);
    this.synchronousSqlite = transactionMode === 'sync';
    this.actionProposalAdmissionSupported = transactionMode !== 'unsupported';
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

  createReplacingActionProposal(input: CreateActionProposal): Promise<CreateActionProposalResult> {
    if (!input.replacementKey) return this.createActionProposal(input);
    const proposal = initialActionProposal(input, this.clock());
    return this.transactionSteps((db) => this.replacementSteps(db, input, proposal));
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

  private *replacementSteps(
    db: AgentSqliteDb,
    input: CreateActionProposal,
    proposal: ActionProposal,
  ): Generator<AdmissionQuery, CreateActionProposalResult, unknown> {
    const table = this.table;
    const thread = agentTablesFor(this.dialect).agentThread;
    // The shared conversation admission row serializes new replacements within this scope.
    if (this.dialect === 'sqlite')
      yield {
        kind: 'write',
        query: db
          .update(thread)
          .set({ updatedAt: sql`${thread.updatedAt}` })
          .where(eq(thread.id, input.threadId)),
      };
    const threads = (yield {
      kind: 'read',
      query: lockQuery(
        db.select().from(thread).where(eq(thread.id, input.threadId)).limit(1),
        this.dialect,
      ),
    }) as Array<AgentTables['agentThread']['$inferSelect']>;
    const owner = threads[0];
    if (
      !owner ||
      owner.id !== input.threadId ||
      owner.deletedAt ||
      owner.actorRef !== input.actorRef ||
      owner.tenantRef !== input.tenantRef
    )
      return { status: 'conflict' };
    const existingRows = (yield {
      kind: 'read',
      query: db
        .select()
        .from(table)
        .where(eq(table.id, physicalId(input.id)))
        .limit(1),
    }) as ProposalRow[];
    const existing = existingRows[0];
    if (existing) {
      if (
        existing.proposal.id !== input.id ||
        !actionProposalScopeMatches(existing.proposal, input)
      )
        return { status: 'conflict' };
      return {
        status:
          existing.createFingerprint === canonicalActionProposalJson(input)
            ? 'unchanged'
            : 'conflict',
        proposal: existing.proposal,
      };
    }
    const groupKey = replacementGroupKey(input);
    if (groupKey === null) throw new Error('Missing explicit replacement identity');
    const pending = (yield {
      kind: 'read',
      query: lockQuery(
        db
          .select()
          .from(table)
          .where(
            and(
              eq(table.scopeKey, scopeKey(input)),
              eq(table.replacementGroupKey, groupKey),
              eq(table.decision, 'pending'),
            ),
          ),
        this.dialect,
      ),
    }) as ProposalRow[];
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
    const insert = db.insert(table);
    const inserted = yield {
      kind: 'read',
      query:
        this.dialect === 'mysql'
          ? (insert as unknown as MySqlInsertIgnore<typeof row>).ignore().values(row)
          : insert.values(row).onConflictDoNothing().returning({ id: table.id }),
    };
    const count =
      this.dialect === 'mysql' ? mysqlAffectedRows(inserted) : (inserted as unknown[]).length;
    if (count !== 1) return { status: 'conflict' };
    for (const old of pending) {
      const result = transitionActionProposalSupersession(
        old.proposal,
        proposal,
        { replacementProposalId: proposal.id, actorRef: proposal.actorRef, via: 'replacement' },
        this.clock(),
      );
      if (
        !result.proposal ||
        canonicalActionProposalJson(result.proposal) === canonicalActionProposalJson(old.proposal)
      )
        continue;
      const next = result.proposal;
      const update = db
        .update(table)
        .set({
          proposal: next,
          decision: next.decision,
          ...discoveryMetadata(next),
          version: old.version + 1,
        })
        .where(and(eq(table.id, old.id), eq(table.version, old.version)));
      const updated = yield {
        kind: 'read',
        query: this.dialect === 'mysql' ? update : update.returning({ id: table.id }),
      };
      if (
        (this.dialect === 'mysql' ? mysqlAffectedRows(updated) : (updated as unknown[]).length) !==
        1
      )
        throw new Error('Replacement lost its locked proposal fence');
      const settled = this.toolCallSettlement(db, old.proposal, next);
      if (settled) yield { kind: 'write', query: settled };
    }
    return { status: 'created', proposal };
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
          query.after === undefined
            ? undefined
            : or(
                gt(this.table.createdAt, query.after.createdAt),
                and(
                  eq(this.table.createdAt, query.after.createdAt),
                  gt(this.table.logicalSort, logicalSort(query.after.id)),
                ),
              ),
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

  async rememberedActionProposalApprovals(scope: ActionProposalScope): Promise<string[]> {
    const table = this.table;
    const rows = await this.db
      .select()
      .from(table)
      .where(
        and(
          eq(table.scopeKey, scopeKey(scope)),
          eq(table.decision, 'approved'),
          or(eq(table.executionStatus, 'succeeded'), eq(table.executionStatus, 'failed')),
        ),
      );
    return [
      ...new Set(
        rows
          .filter(
            (row) =>
              actionProposalScopeMatches(row.proposal, scope) &&
              row.proposal.decisionAudit?.remember === true,
          )
          .map((row) => row.proposal.toolName),
      ),
    ];
  }

  async getThreadActionProposalScope(threadId: string) {
    const thread = agentTablesFor(this.dialect).agentThread;
    const [row] = await this.db
      .select()
      .from(thread)
      .where(and(eq(thread.id, threadId), isNull(thread.deletedAt)))
      .limit(1);
    return row?.id === threadId
      ? { actorRef: row.actorRef, tenantRef: row.tenantRef, threadId: row.id }
      : null;
  }

  async claimNextActionProposalOutcome(command: ClaimActionProposal) {
    const now = this.clock();
    validateActionProposalWorkerClaim(command, now);
    const table = this.table;
    const candidates = await this.db
      .select()
      .from(table)
      .where(
        and(
          eq(table.deliveryStatus, 'pending'),
          or(isNull(table.deliveryLeaseExpiresAt), lte(table.deliveryLeaseExpiresAt, now)),
        ),
      )
      .orderBy(asc(table.createdAt), asc(table.logicalSort))
      .limit(32);
    for (const row of candidates) {
      const result = await this.mutate(row.proposal, row.proposal.id, (proposal, time) => {
        const claimed = claimActionProposalOutcome(proposal, command, time, randomUUID());
        return claimed
          ? { status: 'applied', proposal: claimed }
          : { status: 'conflict', proposal };
      });
      const claimed = result.proposal;
      if (result.status === 'applied' && claimed?.outcome && claimed.outcomeDelivery?.lease) {
        return {
          outcome: claimed.outcome,
          lease: {
            outcomeId: claimed.outcome.id,
            token: claimed.outcomeDelivery.lease.token,
            generation: claimed.outcomeDelivery.generation,
          },
        };
      }
    }
    return null;
  }

  async admitActionProposalOutcome(
    command: ActionProposalOutcomeLease,
  ): ReturnType<ActionProposalOutcomeStore['admitActionProposalOutcome']> {
    return this.transactionSteps((db) => this.admissionSteps(db, command));
  }

  private async transactionSteps<T>(
    factory: (db: AgentSqliteDb) => Generator<AdmissionQuery, T, unknown>,
  ): Promise<T> {
    if (!this.actionProposalAdmissionSupported)
      throw new Error(
        'Independent actions require a certified transactional Drizzle driver (better-sqlite3, node-postgres, mysql2 or libsql)',
      );
    if (this.synchronousSqlite) {
      const database = this.rawDb as unknown as {
        transaction<R>(callback: (tx: AgentDrizzleDb) => R, config?: { behavior: 'immediate' }): R;
      };
      return database.transaction((tx) => runSync(factory(asBuilder(tx))), {
        behavior: 'immediate',
      });
    }
    const database = this.rawDb as unknown as {
      transaction<R>(callback: (tx: AgentDrizzleDb) => Promise<R>): Promise<R>;
    };
    return database.transaction(async (tx) => runAsync(factory(asBuilder(tx))));
  }

  private *admissionSteps(
    db: AgentSqliteDb,
    command: ActionProposalOutcomeLease,
  ): Generator<
    AdmissionQuery,
    Awaited<ReturnType<ActionProposalOutcomeStore['admitActionProposalOutcome']>>,
    unknown
  > {
    if (
      typeof command.outcomeId !== 'string' ||
      !command.outcomeId ||
      typeof command.token !== 'string' ||
      !command.token ||
      !Number.isSafeInteger(command.generation) ||
      command.generation < 1
    )
      throw new TypeError('Invalid outcome fence');
    const table = this.table;
    const tables = agentTablesFor(this.dialect);
    // Write first on asynchronous SQLite too; serialize before reading the proposal or thread.
    if (this.dialect === 'sqlite')
      yield {
        kind: 'write',
        query: db
          .update(table)
          .set({ version: sql`${table.version}` })
          .where(eq(table.outcomeIdKey, physicalId(command.outcomeId))),
      };
    const query = db
      .select()
      .from(table)
      .where(eq(table.outcomeIdKey, physicalId(command.outcomeId)))
      .limit(1);
    const rows = (yield { kind: 'read', query: lockQuery(query, this.dialect) }) as ProposalRow[];
    const row = rows[0];
    if (!row || row.proposal.outcome?.id !== command.outcomeId) return { status: 'not_found' };
    const proposal = row.proposal;
    const outcome = proposal.outcome;
    const delivery = proposal.outcomeDelivery;
    if (!outcome || !delivery) return { status: 'not_found' };
    if (proposal.outcomeDelivery?.status === 'admitted')
      return {
        status: 'unchanged',
        ...(proposal.outcomeDelivery.messageId !== undefined
          ? { messageId: proposal.outcomeDelivery.messageId }
          : {}),
      };
    if (proposal.outcomeDelivery?.status === 'discarded') return { status: 'discarded' };
    if (!actionProposalOutcomeFenceValid(proposal, command, this.clock()))
      return { status: 'conflict' };
    const threadQuery = db
      .select()
      .from(tables.agentThread)
      .where(eq(tables.agentThread.id, proposal.threadId))
      .limit(1);
    const threads = (yield { kind: 'read', query: lockQuery(threadQuery, this.dialect) }) as Array<
      AgentTables['agentThread']['$inferSelect']
    >;
    const thread = threads[0];
    // Locks may have waited beyond the lease; never use the earlier timestamp to admit.
    const now = this.clock();
    if (!actionProposalOutcomeFenceValid(proposal, command, now)) return { status: 'conflict' };
    if (
      !thread ||
      thread.id !== proposal.threadId ||
      thread.deletedAt ||
      thread.actorRef !== proposal.actorRef ||
      thread.tenantRef !== proposal.tenantRef
    ) {
      const discarded: ActionProposal = {
        ...proposal,
        outcomeDelivery: { ...delivery, status: 'discarded', lease: null },
        updatedAt: now,
      };
      yield {
        kind: 'write',
        query: db
          .update(table)
          .set({ proposal: discarded, ...discoveryMetadata(discarded), version: row.version + 1 })
          .where(and(eq(table.id, row.id), eq(table.version, row.version))),
      };
      return { status: 'discarded' };
    }
    if (thread.activeStreamId !== null) return { status: 'busy' };
    const seqRows = (yield {
      kind: 'read',
      query: db
        .select({ last: max(tables.agentMessage.seq) })
        .from(tables.agentMessage)
        .where(eq(tables.agentMessage.threadId, thread.id)),
    }) as Array<{ last: number | null }>;
    const messageId = physicalId(command.outcomeId);
    yield {
      kind: 'write',
      query: db.insert(tables.agentMessage).values({
        id: messageId,
        threadId: thread.id,
        role: 'assistant',
        content: actionProposalOutcomeText(outcome),
        actionProposalOutcome: canonicalActionProposalJson(outcome),
        ui: null,
        seq: Number(seqRows[0]?.last ?? 0) + 1,
        createdAt: new Date(now),
      }),
    };
    yield {
      kind: 'write',
      query: db
        .update(tables.agentThread)
        .set({ updatedAt: new Date(now) })
        .where(eq(tables.agentThread.id, thread.id)),
    };
    const admitted: ActionProposal = {
      ...proposal,
      outcomeDelivery: { ...delivery, status: 'admitted', lease: null, messageId },
      updatedAt: now,
    };
    const update = db
      .update(table)
      .set({ proposal: admitted, ...discoveryMetadata(admitted), version: row.version + 1 })
      .where(and(eq(table.id, row.id), eq(table.version, row.version)));
    const changed = yield {
      kind: 'read',
      query: this.dialect === 'mysql' ? update : update.returning({ id: table.id }),
    };
    const count =
      this.dialect === 'mysql' ? mysqlAffectedRows(changed) : (changed as unknown[]).length;
    if (count !== 1) throw new Error('Outcome admission lost its locked proposal fence');
    return { status: 'applied', messageId };
  }

  /**
   * The update that settles the proposal's `proposed` tool-call record after a transition from
   * `previous` to `next` (see `toolCallUpdateForTransition`), or `undefined` when its status stays —
   * so the dashboard and run detail show `executed` / `failed` / `rejected` / `expired` instead of
   * `proposed` forever.
   */
  private toolCallSettlement(db: AgentSqliteDb, previous: ActionProposal, next: ActionProposal) {
    const update = toolCallUpdateForTransition(previous, next);
    if (update === null) return undefined;
    const toolCall = agentTablesFor(this.dialect).agentToolCall;
    return db
      .update(toolCall)
      .set({
        status: update.status,
        ...(update.output !== undefined ? { output: update.output } : {}),
        ...(update.error !== undefined ? { error: update.error } : {}),
        ...(update.executedByRef !== undefined ? { executedByRef: update.executedByRef } : {}),
        ...(update.decidedVia !== undefined ? { decidedVia: update.decidedVia } : {}),
        ...(update.remember !== undefined ? { remember: update.remember } : {}),
        ...(update.status === 'executed' ? { executedAt: new Date(this.clock()) } : {}),
      })
      .where(and(eq(toolCall.id, update.toolCallId), eq(toolCall.proposalId, next.id)));
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
      if (changed === 1) {
        await this.toolCallSettlement(this.db, row.proposal, result.proposal);
        return result;
      }
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
    replacementGroupKey: replacementGroupKey(proposal),
    deliveryStatus: proposal.outcomeDelivery?.status ?? null,
    deliveryLeaseExpiresAt: proposal.outcomeDelivery?.lease?.expiresAt ?? null,
    outcomeIdKey: proposal.outcome ? physicalId(proposal.outcome.id) : null,
    executionStatus: proposal.execution?.status ?? null,
    leaseExpiresAt: proposal.execution?.lease?.expiresAt ?? null,
    proposalExpiresAt: proposal.expiresAt,
    discoveryIndexVersion: 1,
  };
}

interface AdmissionQuery {
  kind: 'read' | 'write';
  query: PromiseLike<unknown>;
}
function lockQuery(query: PromiseLike<unknown>, dialect: AgentDialect): PromiseLike<unknown> {
  return dialect === 'sqlite'
    ? query
    : (query as unknown as { for(mode: 'update'): PromiseLike<unknown> }).for('update');
}
function runSync<T>(steps: Generator<AdmissionQuery, T, unknown>): T {
  let next = steps.next();
  while (!next.done) {
    const { kind, query } = next.value;
    const statement = query as unknown as { all(): unknown; run(): unknown };
    next = steps.next(kind === 'read' ? statement.all() : statement.run());
  }
  return next.value;
}
async function runAsync<T>(steps: Generator<AdmissionQuery, T, unknown>): Promise<T> {
  let next = steps.next();
  while (!next.done) next = steps.next(await next.value.query);
  return next.value;
}

function replacementGroupKey(
  proposal: Pick<CreateActionProposal, 'toolName' | 'replacementKey'>,
): string | null {
  return proposal.replacementKey
    ? physicalId(canonicalActionProposalJson([proposal.toolName, proposal.replacementKey]))
    : null;
}
