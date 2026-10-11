import {
  type PoppyContext,
  type PoppyConversationPatch,
  type PoppyConversationRecord,
  type PoppyEvent,
  type PoppyEventBody,
  type PoppyGrant,
  type PoppyMessageClaim,
  type PoppyMessageReceipt,
  type PoppyResponder,
  type PoppyStatus,
  type PoppyStore,
  type StoredPoppyEvent,
  newEventId,
} from '@dudousxd/nestjs-agent-core';
import { and, desc, eq, gt, isNull, lt, lte, or } from 'drizzle-orm';
import {
  type AgentDialect,
  type AgentDrizzleDb,
  type AgentSqliteDb,
  type AgentTables,
  affectedRows,
  agentDialectOf,
  agentTablesFor,
  asBuilder,
  isUniqueViolation,
  mysqlAffectedRows,
} from './dialect.js';

/** The slice of Drizzle's MySQL insert builder used here, which the SQLite view does not have. */
interface MySqlInsertIgnore<Row> {
  ignore(): { values(value: Row): PromiseLike<unknown> };
}

/** How many times an append re-numbers itself after losing its position to another append. */
const MAX_APPEND_ATTEMPTS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const nullable = (value: unknown): string | null => (value == null ? null : String(value));

function toInt(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number.parseInt(value, 10) || 0;
  return 0;
}

const PATCH_COLUMNS = {
  accountRef: 'accountRef',
  threadId: 'threadId',
  openDirectId: 'openDirectId',
  status: 'status',
  responder: 'responder',
  context: 'context',
  activeRunId: 'activeRunId',
  turnSeq: 'turnSeq',
  grant: 'grantInfo',
  prunedSeq: 'prunedSeq',
} as const satisfies Record<keyof PoppyConversationPatch, string>;

/**
 * A `PoppyStore` (Personal Agent Protocol conversations, `@dudousxd/nestjs-agent-poppy`) over the
 * `agent_poppy_conversation`, `agent_poppy_event` and `agent_poppy_message` tables — shared by every
 * replica. The tables come from `ensureAgentSchema` (or your own migration).
 *
 * Every race is settled by a key rather than a lock: an event's primary key is its position, so of
 * two appends numbered alike one inserts and the other re-numbers itself after it; `(conversation,
 * event_key)` is unique, so a keyed append happens once; a message's `(owner, message_id)` is the
 * idempotency lock. Those inserts skip a duplicate (`ON CONFLICT DO NOTHING`, `INSERT IGNORE` on
 * MySQL) rather than fail on it, so they never abort a surrounding Postgres transaction. The reader
 * lease is one conditional `UPDATE` of the conversation row.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec).
 */
export class DrizzlePoppyStore implements PoppyStore {
  private readonly db: AgentSqliteDb;
  private readonly dialect: AgentDialect;
  private readonly t: AgentTables;

  constructor(db: AgentDrizzleDb) {
    this.dialect = agentDialectOf(db);
    this.t = agentTablesFor(this.dialect);
    this.db = asBuilder(db);
  }

  async createConversation(record: PoppyConversationRecord): Promise<void> {
    await this.db.insert(this.t.agentPoppyConversation).values({
      id: record.id,
      clientId: record.clientId,
      userId: record.userId,
      accountRef: record.accountRef,
      agentName: record.agentName,
      threadId: record.threadId,
      parentId: record.parentId,
      openDirectId: record.openDirectId,
      status: record.status,
      responder: record.responder,
      context: JSON.stringify(record.context),
      activeRunId: record.activeRunId,
      turnSeq: record.turnSeq,
      grantInfo: record.grant === null ? null : JSON.stringify(record.grant),
      readerHolder: null,
      readerUntil: null,
      prunedSeq: record.prunedSeq,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  async getConversation(id: string): Promise<PoppyConversationRecord | null> {
    const table = this.t.agentPoppyConversation;
    const [row] = await this.db.select().from(table).where(eq(table.id, id)).limit(1);
    if (!row) return null;
    return {
      id: row.id,
      clientId: row.clientId,
      userId: row.userId,
      accountRef: nullable(row.accountRef),
      agentName: row.agentName,
      threadId: nullable(row.threadId),
      parentId: nullable(row.parentId),
      openDirectId: nullable(row.openDirectId),
      status: row.status as PoppyStatus,
      responder: row.responder as PoppyResponder,
      context: row.context == null ? {} : (JSON.parse(row.context) as PoppyContext),
      activeRunId: nullable(row.activeRunId),
      turnSeq: toInt(row.turnSeq),
      grant: row.grantInfo == null ? null : (JSON.parse(row.grantInfo) as PoppyGrant),
      prunedSeq: toInt(row.prunedSeq),
      createdAt: toInt(row.createdAt),
      updatedAt: toInt(row.updatedAt),
    };
  }

  async updateConversation(id: string, patch: PoppyConversationPatch): Promise<void> {
    const table = this.t.agentPoppyConversation;
    const set: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
      const value = patch[key as keyof PoppyConversationPatch];
      if (value === undefined) continue;
      set[column] =
        key === 'context' || (key === 'grant' && value !== null) ? JSON.stringify(value) : value;
    }
    await this.db
      .update(table)
      .set(set as typeof table.$inferInsert)
      .where(eq(table.id, id));
  }

  async appendEvent(
    conversationId: string,
    body: PoppyEventBody,
    options: { key?: string } = {},
  ): Promise<{ event: StoredPoppyEvent; created: boolean }> {
    const table = this.t.agentPoppyEvent;
    for (let attempt = 1; ; attempt++) {
      if (options.key !== undefined) {
        const [existing] = await this.db
          .select({ seq: table.seq, event: table.event })
          .from(table)
          .where(and(eq(table.conversationId, conversationId), eq(table.eventKey, options.key)))
          .limit(1);
        if (existing) {
          return {
            event: { seq: toInt(existing.seq), event: JSON.parse(existing.event) as PoppyEvent },
            created: false,
          };
        }
      }
      const seq = (await this.lastSeq(conversationId)) + 1;
      const now = Date.now();
      const stored: StoredPoppyEvent = {
        seq,
        event: { id: newEventId(seq), created_at: new Date(now).toISOString(), ...body },
      };
      let inserted = false;
      try {
        inserted = await this.insertIgnore(table, {
          conversationId,
          seq,
          id: stored.event.id,
          type: body.type,
          event: JSON.stringify(stored.event),
          eventKey: options.key ?? null,
          createdAt: now,
        });
      } catch (error) {
        // MySQL may settle two inserts into one gap with a deadlock rather than a skipped duplicate.
        if (!isUniqueViolation(error)) throw error;
      }
      if (inserted) return { event: stored, created: true };
      // Another append took this position (or this key) first: look again, numbered after it.
      if (attempt >= MAX_APPEND_ATTEMPTS) {
        throw new Error(`poppy: could not append to ${conversationId} after ${attempt} attempts`);
      }
      await sleep(Math.random() * Math.min(attempt, 10) * 2);
    }
  }

  /** The last position taken: the last event's, or — every event pruned — the pruned floor. */
  private async lastSeq(conversationId: string): Promise<number> {
    const table = this.t.agentPoppyEvent;
    const [last] = await this.db
      .select({ seq: table.seq })
      .from(table)
      .where(eq(table.conversationId, conversationId))
      .orderBy(desc(table.seq))
      .limit(1);
    if (last) return toInt(last.seq);
    const conversations = this.t.agentPoppyConversation;
    const [conversation] = await this.db
      .select({ prunedSeq: conversations.prunedSeq })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    return toInt(conversation?.prunedSeq);
  }

  async listEvents(
    conversationId: string,
    afterSeq: number,
    limit: number,
  ): Promise<StoredPoppyEvent[]> {
    const table = this.t.agentPoppyEvent;
    const rows = await this.db
      .select({ seq: table.seq, event: table.event })
      .from(table)
      .where(and(eq(table.conversationId, conversationId), gt(table.seq, afterSeq)))
      .orderBy(table.seq)
      .limit(limit);
    return rows.map((row) => ({ seq: toInt(row.seq), event: JSON.parse(row.event) as PoppyEvent }));
  }

  async findEventSeq(conversationId: string, eventId: string): Promise<number | null> {
    const table = this.t.agentPoppyEvent;
    const [row] = await this.db
      .select({ seq: table.seq })
      .from(table)
      .where(and(eq(table.conversationId, conversationId), eq(table.id, eventId)))
      .limit(1);
    return row ? toInt(row.seq) : null;
  }

  async pruneEvents(conversationId: string, before: number): Promise<void> {
    const table = this.t.agentPoppyEvent;
    const [last] = await this.db
      .select({ seq: table.seq })
      .from(table)
      .where(eq(table.conversationId, conversationId))
      .orderBy(desc(table.seq))
      .limit(1);
    if (!last) return;
    // The newest event old enough to go, short of the last: it and everything before it go.
    const [dropped] = await this.db
      .select({ seq: table.seq })
      .from(table)
      .where(
        and(
          eq(table.conversationId, conversationId),
          lt(table.createdAt, before),
          lt(table.seq, toInt(last.seq)),
        ),
      )
      .orderBy(desc(table.seq))
      .limit(1);
    if (!dropped) return;
    const upTo = toInt(dropped.seq);
    // The floor moves first, so a reader never takes the gap for events not yet written.
    const conversations = this.t.agentPoppyConversation;
    await this.db
      .update(conversations)
      .set({ prunedSeq: upTo })
      .where(and(eq(conversations.id, conversationId), lt(conversations.prunedSeq, upTo)));
    await this.db
      .delete(table)
      .where(and(eq(table.conversationId, conversationId), lte(table.seq, upTo)));
  }

  async claimMessage(
    owner: string,
    messageId: string,
    receipt: PoppyMessageReceipt,
  ): Promise<PoppyMessageClaim> {
    const table = this.t.agentPoppyMessage;
    for (let attempt = 1; ; attempt++) {
      const inserted = await this.insertIgnore(table, {
        owner,
        messageId,
        fingerprint: receipt.fingerprint,
        conversationId: receipt.conversationId,
        response: JSON.stringify(receipt.response),
        createdAt: Date.now(),
      });
      if (inserted) return { status: 'claimed' };
      const [row] = await this.db
        .select()
        .from(table)
        .where(and(eq(table.owner, owner), eq(table.messageId, messageId)))
        .limit(1);
      if (row) {
        return {
          status: 'existing',
          fingerprint: row.fingerprint,
          conversationId: row.conversationId,
          response: JSON.parse(row.response) as PoppyMessageReceipt['response'],
        };
      }
      // Released between the two statements: claim afresh.
      if (attempt >= 5) throw new Error(`poppy: could not claim message ${messageId}`);
    }
  }

  async releaseMessage(owner: string, messageId: string): Promise<void> {
    const table = this.t.agentPoppyMessage;
    await this.db.delete(table).where(and(eq(table.owner, owner), eq(table.messageId, messageId)));
  }

  async leaseReader(conversationId: string, holder: string, ttlMs: number): Promise<boolean> {
    const table = this.t.agentPoppyConversation;
    const now = Date.now();
    // One conditional update: free, already ours, or expired. Of two takers the row lock serializes
    // them, and the second's condition no longer holds.
    const taken = await affectedRows(
      this.dialect,
      this.db
        .update(table)
        .set({ readerHolder: holder, readerUntil: now + ttlMs })
        .where(
          and(
            eq(table.id, conversationId),
            or(
              isNull(table.readerHolder),
              eq(table.readerHolder, holder),
              lte(table.readerUntil, now),
            ),
          ),
        ),
      table.id,
    );
    if (taken === 1) return true;
    if (this.dialect !== 'mysql') return false;
    // MySQL may count only CHANGED rows (no FOUND_ROWS): a renewal in the same millisecond reads 0.
    const [row] = await this.db
      .select({ holder: table.readerHolder })
      .from(table)
      .where(eq(table.id, conversationId))
      .limit(1);
    return row?.holder === holder;
  }

  async releaseReader(conversationId: string, holder: string): Promise<void> {
    const table = this.t.agentPoppyConversation;
    await this.db
      .update(table)
      .set({ readerHolder: null, readerUntil: null })
      .where(and(eq(table.id, conversationId), eq(table.readerHolder, holder)));
  }

  /** Insert `row`, skipping it on any duplicate key. `true` when it went in. */
  private async insertIgnore<Row extends Record<string, unknown>>(
    table: AgentTables['agentPoppyEvent'] | AgentTables['agentPoppyMessage'],
    row: Row,
  ): Promise<boolean> {
    if (this.dialect === 'mysql') {
      const insert = this.db.insert(table) as unknown as MySqlInsertIgnore<Row>;
      return mysqlAffectedRows(await insert.ignore().values(row)) === 1;
    }
    const statement = this.db
      .insert(table)
      .values(row as never)
      .onConflictDoNothing();
    return (await affectedRows(this.dialect, statement, table.createdAt)) === 1;
  }
}
