import {
  type PoppyConversationPatch,
  type PoppyConversationRecord,
  type PoppyEvent,
  type PoppyEventBody,
  type PoppyMessageClaim,
  type PoppyMessageReceipt,
  type PoppyStore,
  type StoredPoppyEvent,
  newEventId,
} from '@dudousxd/nestjs-agent-core';

/**
 * The slice of a Redis client {@link RedisPoppyStore} uses. An `ioredis` client has it as is
 * (`new RedisPoppyStore(redis)`); adapt any other driver to these commands.
 */
export interface RedisPoppyClient {
  get(key: string): Promise<string | null>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, nx: 'NX'): Promise<unknown>;
  set(key: string, value: string, px: 'PX', ttlMs: number): Promise<unknown>;
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  incr(key: string): Promise<number>;
}

export interface RedisPoppyStoreOptions {
  /** Prepended to every key. Default `agent:poppy:`. */
  prefix?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A `PoppyStore` (Personal Agent Protocol conversations, `@dudousxd/nestjs-agent-poppy`) shared by
 * every replica, over Redis. Positions come from `INCR`, so two appends never share one; a message
 * claim, an event key and the reader lease are `SET … NX`. Conversations are JSON values, events one
 * key each (`<prefix>evt:<conversation>:<seq>`). Nothing expires on its own: prune events with
 * `pruneEvents`.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec).
 */
export class RedisPoppyStore implements PoppyStore {
  private readonly p: string;

  constructor(
    private readonly redis: RedisPoppyClient,
    options: RedisPoppyStoreOptions = {},
  ) {
    this.p = options.prefix ?? 'agent:poppy:';
  }

  private conversationKey = (id: string) => `${this.p}cnv:${id}`;
  private seqKey = (id: string) => `${this.p}seq:${id}`;
  private eventKey = (id: string, seq: number) => `${this.p}evt:${id}:${seq}`;
  private eventIdKey = (id: string, eventId: string) => `${this.p}evtid:${id}:${eventId}`;
  private eventDedupeKey = (id: string, key: string) => `${this.p}evtkey:${id}:${key}`;
  private messageKey = (owner: string, messageId: string) => `${this.p}msg:${owner}:${messageId}`;
  private leaseKey = (id: string) => `${this.p}lease:${id}`;

  private async lastSeq(id: string): Promise<number> {
    return Number.parseInt((await this.redis.get(this.seqKey(id))) ?? '0', 10) || 0;
  }

  async createConversation(record: PoppyConversationRecord): Promise<void> {
    await this.redis.set(this.conversationKey(record.id), JSON.stringify(record));
  }

  async getConversation(id: string): Promise<PoppyConversationRecord | null> {
    const raw = await this.redis.get(this.conversationKey(id));
    return raw === null ? null : (JSON.parse(raw) as PoppyConversationRecord);
  }

  async updateConversation(id: string, patch: PoppyConversationPatch): Promise<void> {
    const current = await this.getConversation(id);
    if (!current) return;
    await this.redis.set(
      this.conversationKey(id),
      JSON.stringify({ ...current, ...patch, updatedAt: Date.now() }),
    );
  }

  async appendEvent(
    conversationId: string,
    body: PoppyEventBody,
    options: { key?: string } = {},
  ): Promise<{ event: StoredPoppyEvent; created: boolean }> {
    if (options.key !== undefined) {
      const dedupe = this.eventDedupeKey(conversationId, options.key);
      if ((await this.redis.set(dedupe, 'pending', 'NX')) === null) {
        // Taken: answer the event it points at, once its writer has numbered it.
        for (let i = 0; i < 100; i++) {
          const seq = Number.parseInt((await this.redis.get(dedupe)) ?? '', 10);
          if (Number.isSafeInteger(seq)) {
            const raw = await this.redis.get(this.eventKey(conversationId, seq));
            if (raw !== null) {
              return { event: { seq, event: JSON.parse(raw) as PoppyEvent }, created: false };
            }
          }
          await sleep(10);
        }
        throw new Error(`poppy: event key ${options.key} never resolved`);
      }
    }
    // A pruned conversation keeps its counter, so positions continue past the pruned ones.
    const seq = await this.redis.incr(this.seqKey(conversationId));
    const now = Date.now();
    const stored: StoredPoppyEvent = {
      seq,
      event: { id: newEventId(seq), created_at: new Date(now).toISOString(), ...body },
    };
    await this.redis.set(this.eventKey(conversationId, seq), JSON.stringify(stored.event));
    await this.redis.set(this.eventIdKey(conversationId, stored.event.id), String(seq));
    if (options.key !== undefined) {
      await this.redis.set(this.eventDedupeKey(conversationId, options.key), String(seq));
    }
    return { event: stored, created: true };
  }

  async listEvents(
    conversationId: string,
    afterSeq: number,
    limit: number,
  ): Promise<StoredPoppyEvent[]> {
    const last = await this.lastSeq(conversationId);
    const pruned = (await this.getConversation(conversationId))?.prunedSeq ?? 0;
    const seqs: number[] = [];
    for (let seq = Math.max(afterSeq, pruned) + 1; seq <= last && seqs.length < limit; seq++) {
      seqs.push(seq);
    }
    if (seqs.length === 0) return [];
    const raws = await this.redis.mget(...seqs.map((seq) => this.eventKey(conversationId, seq)));
    const out: StoredPoppyEvent[] = [];
    for (const [index, raw] of raws.entries()) {
      // A position whose write is still in flight ends the page: nothing is skipped over.
      if (raw === null) break;
      out.push({ seq: seqs[index] as number, event: JSON.parse(raw) as PoppyEvent });
    }
    return out;
  }

  async findEventSeq(conversationId: string, eventId: string): Promise<number | null> {
    const raw = await this.redis.get(this.eventIdKey(conversationId, eventId));
    if (raw === null) return null;
    const seq = Number.parseInt(raw, 10);
    return (await this.redis.get(this.eventKey(conversationId, seq))) === null ? null : seq;
  }

  async pruneEvents(conversationId: string, before: number): Promise<void> {
    const conversation = await this.getConversation(conversationId);
    const last = await this.lastSeq(conversationId);
    const from = conversation?.prunedSeq ?? 0;
    let upTo = from;
    const doomed: string[] = [];
    // Short of the last: the last event always stays.
    for (let seq = from + 1; seq < last; seq++) {
      const raw = await this.redis.get(this.eventKey(conversationId, seq));
      if (raw !== null) {
        const event = JSON.parse(raw) as PoppyEvent;
        if (Date.parse(event.created_at) >= before) break;
        doomed.push(this.eventKey(conversationId, seq), this.eventIdKey(conversationId, event.id));
      }
      upTo = seq;
    }
    if (!conversation || upTo === from) return;
    // Readers learn the new floor before the events go, so none mistakes the gap for a write.
    await this.redis.set(
      this.conversationKey(conversationId),
      JSON.stringify({ ...conversation, prunedSeq: upTo }),
    );
    if (doomed.length > 0) await this.redis.del(...doomed);
  }

  async claimMessage(
    owner: string,
    messageId: string,
    receipt: PoppyMessageReceipt,
  ): Promise<PoppyMessageClaim> {
    const key = this.messageKey(owner, messageId);
    for (let attempt = 1; ; attempt++) {
      if ((await this.redis.set(key, JSON.stringify(receipt), 'NX')) !== null) {
        return { status: 'claimed' };
      }
      const raw = await this.redis.get(key);
      if (raw !== null) return { status: 'existing', ...(JSON.parse(raw) as PoppyMessageReceipt) };
      // Released between the two commands: claim afresh.
      if (attempt >= 5) throw new Error(`poppy: could not claim message ${messageId}`);
    }
  }

  async releaseMessage(owner: string, messageId: string): Promise<void> {
    await this.redis.del(this.messageKey(owner, messageId));
  }

  async leaseReader(conversationId: string, holder: string, ttlMs: number): Promise<boolean> {
    const key = this.leaseKey(conversationId);
    const ttl = Math.max(1, Math.round(ttlMs));
    if ((await this.redis.set(key, holder, 'PX', ttl, 'NX')) !== null) return true;
    if ((await this.redis.get(key)) !== holder) return false;
    await this.redis.set(key, holder, 'PX', ttl);
    return true;
  }

  async releaseReader(conversationId: string, holder: string): Promise<void> {
    const key = this.leaseKey(conversationId);
    if ((await this.redis.get(key)) === holder) await this.redis.del(key);
  }
}
