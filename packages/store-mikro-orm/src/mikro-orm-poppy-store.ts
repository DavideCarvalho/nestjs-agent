import {
  POPPY_TABLES,
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
import type { EntityManager } from '@mikro-orm/core';

/** How many rows a native write touched, whatever the driver reports it as. */
function affected(result: unknown): number {
  const count = (result as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof count === 'number' ? count : 0;
}

/**
 * Did this write lose a race it can retry? A duplicate key (Postgres `23505`, MySQL 1062, SQLite's
 * constraint codes) or, on MySQL, being the deadlock victim of two inserts into one gap (1213).
 */
function isRetryable(error: unknown): boolean {
  for (let current = error; current !== null && typeof current === 'object'; ) {
    const { code, errno, name } = current as { code?: unknown; errno?: unknown; name?: unknown };
    if (
      name === 'UniqueConstraintViolationException' ||
      name === 'DeadlockException' ||
      code === '23505' ||
      code === 'ER_DUP_ENTRY' ||
      errno === 1062 ||
      code === 'ER_LOCK_DEADLOCK' ||
      errno === 1213 ||
      (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT'))
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function toInt(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number.parseInt(value, 10) || 0;
  return 0;
}

const nullable = (value: unknown): string | null => (value == null ? null : String(value));

/** How many times an append re-numbers itself after losing its position to another append. */
const MAX_APPEND_ATTEMPTS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PATCH_COLUMNS: Record<keyof PoppyConversationPatch, string> = {
  accountRef: 'account_ref',
  threadId: 'thread_id',
  openDirectId: 'open_direct_id',
  status: 'status',
  responder: 'responder',
  context: 'context',
  activeRunId: 'active_run_id',
  turnSeq: 'turn_seq',
  grant: 'grant_info',
  prunedSeq: 'pruned_seq',
};

const C = POPPY_TABLES.conversations;
const E = POPPY_TABLES.events;
const M = POPPY_TABLES.messages;

/**
 * A `PoppyStore` (Personal Agent Protocol conversations, `@dudousxd/nestjs-agent-poppy`) over the
 * `agent_poppy_conversation`, `agent_poppy_event` and `agent_poppy_message` tables — shared by every
 * replica. A POJO receiving an {@link EntityManager}; each operation runs on a fresh `em.fork()`.
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
export class MikroOrmPoppyStore implements PoppyStore {
  constructor(private readonly em: EntityManager) {}

  private get mysql(): boolean {
    const platform = this.em.getPlatform().constructor.name.toLowerCase();
    return platform.includes('mysql') || platform.includes('maria');
  }

  /** `sql` with `"identifiers"` quoted for the platform — `type`, `event`, `owner`… */
  private execute(statement: string, params: unknown[], method: 'run' | 'all' = 'run') {
    const sql = this.mysql ? statement.replaceAll('"', '`') : statement;
    return this.em.fork().getConnection().execute(sql, params, method);
  }

  private async rows(statement: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    return (await this.execute(statement, params, 'all')) as Record<string, unknown>[];
  }

  /** Insert, skipping on any duplicate key. `true` when the row went in. */
  private async insertIgnore(table: string, row: Record<string, unknown>): Promise<boolean> {
    const columns = Object.keys(row);
    const list = columns.map((column) => `"${column}"`).join(', ');
    const marks = columns.map(() => '?').join(', ');
    const sql = this.mysql
      ? `insert ignore into "${table}" (${list}) values (${marks})`
      : `insert into "${table}" (${list}) values (${marks}) on conflict do nothing`;
    return affected(await this.execute(sql, Object.values(row))) === 1;
  }

  async createConversation(record: PoppyConversationRecord): Promise<void> {
    await this.execute(
      `insert into "${C}" ("id", "client_id", "user_id", "account_ref", "agent_name", "thread_id", "parent_id", "open_direct_id", "status", "responder", "context", "active_run_id", "turn_seq", "grant_info", "reader_holder", "reader_until", "pruned_seq", "created_at", "updated_at") values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, ?, ?, ?)`,
      [
        record.id,
        record.clientId,
        record.userId,
        record.accountRef,
        record.agentName,
        record.threadId,
        record.parentId,
        record.openDirectId,
        record.status,
        record.responder,
        JSON.stringify(record.context),
        record.activeRunId,
        record.turnSeq,
        record.grant === null ? null : JSON.stringify(record.grant),
        record.prunedSeq,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async getConversation(id: string): Promise<PoppyConversationRecord | null> {
    const [row] = await this.rows(`select * from "${C}" where "id" = ?`, [id]);
    if (!row) return null;
    return {
      id: String(row.id),
      clientId: String(row.client_id),
      userId: String(row.user_id),
      accountRef: nullable(row.account_ref),
      agentName: String(row.agent_name),
      threadId: nullable(row.thread_id),
      parentId: nullable(row.parent_id),
      openDirectId: nullable(row.open_direct_id),
      status: String(row.status) as PoppyStatus,
      responder: String(row.responder) as PoppyResponder,
      context: row.context == null ? {} : (JSON.parse(String(row.context)) as PoppyContext),
      activeRunId: nullable(row.active_run_id),
      turnSeq: toInt(row.turn_seq),
      grant: row.grant_info == null ? null : (JSON.parse(String(row.grant_info)) as PoppyGrant),
      prunedSeq: toInt(row.pruned_seq),
      createdAt: toInt(row.created_at),
      updatedAt: toInt(row.updated_at),
    };
  }

  async updateConversation(id: string, patch: PoppyConversationPatch): Promise<void> {
    const sets = ['"updated_at" = ?'];
    const params: unknown[] = [Date.now()];
    for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
      const value = patch[key as keyof PoppyConversationPatch];
      if (value === undefined) continue;
      sets.push(`"${column}" = ?`);
      params.push(
        key === 'context' || (key === 'grant' && value !== null) ? JSON.stringify(value) : value,
      );
    }
    await this.execute(`update "${C}" set ${sets.join(', ')} where "id" = ?`, [...params, id]);
  }

  async appendEvent(
    conversationId: string,
    body: PoppyEventBody,
    options: { key?: string } = {},
  ): Promise<{ event: StoredPoppyEvent; created: boolean }> {
    for (let attempt = 1; ; attempt++) {
      if (options.key !== undefined) {
        const [existing] = await this.rows(
          `select "seq", "event" from "${E}" where "conversation_id" = ? and "event_key" = ?`,
          [conversationId, options.key],
        );
        if (existing) {
          return {
            event: {
              seq: toInt(existing.seq),
              event: JSON.parse(String(existing.event)) as PoppyEvent,
            },
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
        inserted = await this.insertIgnore(E, {
          conversation_id: conversationId,
          seq,
          id: stored.event.id,
          type: body.type,
          event: JSON.stringify(stored.event),
          event_key: options.key ?? null,
          created_at: now,
        });
      } catch (error) {
        // MySQL may settle two inserts into one gap with a deadlock rather than a skipped duplicate.
        if (!isRetryable(error)) throw error;
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
    const [last] = await this.rows(
      `select max("seq") as "seq" from "${E}" where "conversation_id" = ?`,
      [conversationId],
    );
    if (last?.seq != null) return toInt(last.seq);
    const [conversation] = await this.rows(`select "pruned_seq" from "${C}" where "id" = ?`, [
      conversationId,
    ]);
    return toInt(conversation?.pruned_seq);
  }

  async listEvents(
    conversationId: string,
    afterSeq: number,
    limit: number,
  ): Promise<StoredPoppyEvent[]> {
    const rows = await this.rows(
      `select "seq", "event" from "${E}" where "conversation_id" = ? and "seq" > ? order by "seq" asc limit ${Math.max(0, Math.floor(limit))}`,
      [conversationId, afterSeq],
    );
    return rows.map((row) => ({
      seq: toInt(row.seq),
      event: JSON.parse(String(row.event)) as PoppyEvent,
    }));
  }

  async findEventSeq(conversationId: string, eventId: string): Promise<number | null> {
    const [row] = await this.rows(
      `select "seq" from "${E}" where "conversation_id" = ? and "id" = ?`,
      [conversationId, eventId],
    );
    return row ? toInt(row.seq) : null;
  }

  async pruneEvents(conversationId: string, before: number): Promise<void> {
    const [last] = await this.rows(
      `select max("seq") as "seq" from "${E}" where "conversation_id" = ?`,
      [conversationId],
    );
    if (last?.seq == null) return;
    // The newest event old enough to go, short of the last: it and everything before it go.
    const [dropped] = await this.rows(
      `select max("seq") as "seq" from "${E}" where "conversation_id" = ? and "created_at" < ? and "seq" < ?`,
      [conversationId, before, toInt(last.seq)],
    );
    if (dropped?.seq == null) return;
    const upTo = toInt(dropped.seq);
    // The floor moves first, so a reader never takes the gap for events not yet written.
    await this.execute(`update "${C}" set "pruned_seq" = ? where "id" = ? and "pruned_seq" < ?`, [
      upTo,
      conversationId,
      upTo,
    ]);
    await this.execute(`delete from "${E}" where "conversation_id" = ? and "seq" <= ?`, [
      conversationId,
      upTo,
    ]);
  }

  async claimMessage(
    owner: string,
    messageId: string,
    receipt: PoppyMessageReceipt,
  ): Promise<PoppyMessageClaim> {
    for (let attempt = 1; ; attempt++) {
      const inserted = await this.insertIgnore(M, {
        owner,
        message_id: messageId,
        fingerprint: receipt.fingerprint,
        conversation_id: receipt.conversationId,
        response: JSON.stringify(receipt.response),
        created_at: Date.now(),
      });
      if (inserted) return { status: 'claimed' };
      const [row] = await this.rows(`select * from "${M}" where "owner" = ? and "message_id" = ?`, [
        owner,
        messageId,
      ]);
      if (row) {
        return {
          status: 'existing',
          fingerprint: String(row.fingerprint),
          conversationId: String(row.conversation_id),
          response: JSON.parse(String(row.response)) as PoppyMessageReceipt['response'],
        };
      }
      // Released between the two statements: claim afresh.
      if (attempt >= 5) throw new Error(`poppy: could not claim message ${messageId}`);
    }
  }

  async releaseMessage(owner: string, messageId: string): Promise<void> {
    await this.execute(`delete from "${M}" where "owner" = ? and "message_id" = ?`, [
      owner,
      messageId,
    ]);
  }

  async leaseReader(conversationId: string, holder: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    // One conditional update: free, already ours, or expired. Of two takers the row lock serializes
    // them, and the second's condition no longer holds.
    const result = await this.execute(
      `update "${C}" set "reader_holder" = ?, "reader_until" = ? where "id" = ? and ("reader_holder" is null or "reader_holder" = ? or "reader_until" <= ?)`,
      [holder, now + ttlMs, conversationId, holder, now],
    );
    if (affected(result) === 1) return true;
    if (!this.mysql) return false;
    // MySQL may count only CHANGED rows: a renewal in the same millisecond reads 0.
    const [row] = await this.rows(`select "reader_holder" from "${C}" where "id" = ?`, [
      conversationId,
    ]);
    return row?.reader_holder === holder;
  }

  async releaseReader(conversationId: string, holder: string): Promise<void> {
    await this.execute(
      `update "${C}" set "reader_holder" = null, "reader_until" = null where "id" = ? and "reader_holder" = ?`,
      [conversationId, holder],
    );
  }
}
