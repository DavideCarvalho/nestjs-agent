import { randomBytes } from 'node:crypto';
import type { Actor } from '../types.js';
import type {
  PoppyContext,
  PoppyEvent,
  PoppyEventBody,
  PoppyResponder,
  PoppyStatus,
} from './protocol.js';

/**
 * A Poppy conversation as this surface keeps it. It belongs to a Personal Agent (`clientId`) and
 * one of its Users (`userId`); once it used an account here, to that account too (`accountRef`,
 * §7.2). The agent side of it is an agent thread (`threadId`) — a Direct Conversation shares its
 * parent's thread, which is how the Company Agent knows what was said in either (§7.10).
 */
export interface PoppyConversationRecord {
  id: string;
  clientId: string;
  userId: string;
  accountRef: string | null;
  agentName: string;
  threadId: string | null;
  /** Set on a Direct Conversation: the conversation it was opened from. */
  parentId: string | null;
  /** On a parent: its open Direct Conversation. */
  openDirectId: string | null;
  status: PoppyStatus;
  responder: PoppyResponder;
  /** The User's context as last shared — fields a message leaves out keep their value (§7.4). */
  context: PoppyContext;
  /** The run whose reply is being written, while there is one. */
  activeRunId: string | null;
  /**
   * The position of the last message event a turn has taken up. The event log IS the turn queue:
   * user messages after it are what the next turn answers — on whichever replica picks it up.
   */
  turnSeq: number;
  /** Who the latest request came as — what the next turn runs as. */
  grant: PoppyGrant | null;
  /** Events at or below this sequence number were pruned: a cursor there is `cursor_expired`. */
  prunedSeq: number;
  createdAt: number;
  updatedAt: number;
}

/** The identity a conversation's turns run as: that of its latest request (§7.11). */
export interface PoppyGrant {
  actor: Actor;
  /** The token's account scopes; empty when signed out. */
  scopes: string[];
  signedIn: boolean;
}

export type PoppyConversationPatch = Partial<
  Pick<
    PoppyConversationRecord,
    | 'accountRef'
    | 'threadId'
    | 'openDirectId'
    | 'status'
    | 'responder'
    | 'context'
    | 'activeRunId'
    | 'turnSeq'
    | 'grant'
    | 'prunedSeq'
  >
>;

/** An event with its position in the conversation. */
export interface StoredPoppyEvent {
  seq: number;
  event: PoppyEvent;
}

/** What an accepted message keeps for its retries (§7.3). */
export interface PoppyMessageReceipt {
  fingerprint: string;
  conversationId: string;
  /** The HTTP status and body the first delivery got. */
  response: { status: number; body: Record<string, unknown> };
}

export type PoppyMessageClaim =
  | { status: 'claimed' }
  | ({ status: 'existing' } & PoppyMessageReceipt);

/**
 * Where conversations, their events and message receipts live. Events are append-only and read by
 * position, so a cursor replays exactly what came after it, on any replica.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec),
 * a spec still in development: this API WILL change as the spec evolves — possibly in breaking
 * ways, outside semver majors while it is a draft.
 */
export interface PoppyStore {
  createConversation(record: PoppyConversationRecord): Promise<void>;
  getConversation(id: string): Promise<PoppyConversationRecord | null>;
  updateConversation(id: string, patch: PoppyConversationPatch): Promise<void>;
  /**
   * Append an event, numbered after the conversation's last. With `key`, at most one event per key
   * is ever appended: a second append answers the first event with `created: false` — what keeps a
   * re-read turn from writing its reply twice.
   */
  appendEvent(
    conversationId: string,
    body: PoppyEventBody,
    options?: { key?: string },
  ): Promise<{ event: StoredPoppyEvent; created: boolean }>;
  /** Events after `afterSeq`, in order, at most `limit`. */
  listEvents(conversationId: string, afterSeq: number, limit: number): Promise<StoredPoppyEvent[]>;
  /** The position of an event, `null` when the conversation has no such event (any more). */
  findEventSeq(conversationId: string, eventId: string): Promise<number | null>;
  /** Drop the events created before `before` (epoch ms), keeping at least the last one. */
  pruneEvents(conversationId: string, before: number): Promise<void>;
  /** Claim `messageId` for `owner` — atomically, so two deliveries of one message are one. */
  claimMessage(
    owner: string,
    messageId: string,
    receipt: PoppyMessageReceipt,
  ): Promise<PoppyMessageClaim>;
  /** Drop a claim whose message could not be taken, so its retry is processed afresh. */
  releaseMessage(owner: string, messageId: string): Promise<void>;
  /**
   * Take (or renew) the right to write the reply of the conversation's active run for `ttlMs` —
   * `false` while another holder's lease is live. What lets any replica pick up a reply whose
   * writer died, without two writing it at once.
   */
  leaseReader(conversationId: string, holder: string, ttlMs: number): Promise<boolean>;
  releaseReader(conversationId: string, holder: string): Promise<void>;
}

/** `evt_<seq in base 36>_<random>`: unique, and its position survives the event being pruned. */
export function newEventId(seq: number): string {
  return `evt_${seq.toString(36)}_${randomBytes(6).toString('base64url')}`;
}

/** The position an event id was minted at, or `null` for an id this surface never minted. */
export function eventIdSeq(id: string): number | null {
  const match = /^evt_([0-9a-z]{1,11})_[A-Za-z0-9_-]+$/.exec(id);
  if (!match?.[1]) return null;
  const seq = Number.parseInt(match[1], 36);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

function toEvent(seq: number, body: PoppyEventBody, now: number): StoredPoppyEvent {
  return {
    seq,
    event: { id: newEventId(seq), created_at: new Date(now).toISOString(), ...body },
  };
}

// ── In memory ─────────────────────────────────────────────────────────────────

/** Process-local {@link PoppyStore} — tests and single-instance dev. */
export class InMemoryPoppyStore implements PoppyStore {
  readonly #conversations = new Map<string, PoppyConversationRecord>();
  readonly #events = new Map<string, { seq: number; event: PoppyEvent; key: string | null }[]>();
  readonly #messages = new Map<string, PoppyMessageReceipt>();
  readonly #leases = new Map<string, { holder: string; until: number }>();

  async createConversation(record: PoppyConversationRecord): Promise<void> {
    this.#conversations.set(record.id, structuredClone(record));
  }

  async getConversation(id: string): Promise<PoppyConversationRecord | null> {
    const found = this.#conversations.get(id);
    return found ? structuredClone(found) : null;
  }

  async updateConversation(id: string, patch: PoppyConversationPatch): Promise<void> {
    const found = this.#conversations.get(id);
    if (!found) return;
    Object.assign(found, structuredClone(patch), { updatedAt: Date.now() });
  }

  async appendEvent(conversationId: string, body: PoppyEventBody, options: { key?: string } = {}) {
    const list = this.#events.get(conversationId) ?? [];
    this.#events.set(conversationId, list);
    if (options.key !== undefined) {
      const existing = list.find((entry) => entry.key === options.key);
      if (existing) {
        return { event: { seq: existing.seq, event: existing.event }, created: false };
      }
    }
    const conversation = this.#conversations.get(conversationId);
    const last = list.at(-1)?.seq ?? conversation?.prunedSeq ?? 0;
    const stored = toEvent(last + 1, body, Date.now());
    list.push({ ...stored, key: options.key ?? null });
    return { event: structuredClone(stored), created: true };
  }

  async listEvents(conversationId: string, afterSeq: number, limit: number) {
    return (this.#events.get(conversationId) ?? [])
      .filter((entry) => entry.seq > afterSeq)
      .slice(0, limit)
      .map((entry) => structuredClone({ seq: entry.seq, event: entry.event }));
  }

  async findEventSeq(conversationId: string, eventId: string): Promise<number | null> {
    return (
      (this.#events.get(conversationId) ?? []).find((entry) => entry.event.id === eventId)?.seq ??
      null
    );
  }

  async pruneEvents(conversationId: string, before: number): Promise<void> {
    const list = this.#events.get(conversationId) ?? [];
    const cutoff = new Date(before).toISOString();
    const last = list.at(-1);
    const keep = list.filter((entry) => entry === last || entry.event.created_at >= cutoff);
    const dropped = list.filter((entry) => !keep.includes(entry));
    if (dropped.length === 0) return;
    this.#events.set(conversationId, keep);
    const conversation = this.#conversations.get(conversationId);
    if (conversation) {
      conversation.prunedSeq = Math.max(conversation.prunedSeq, ...dropped.map((e) => e.seq));
    }
  }

  async claimMessage(owner: string, messageId: string, receipt: PoppyMessageReceipt) {
    const key = `${owner}\n${messageId}`;
    const found = this.#messages.get(key);
    if (found) return { status: 'existing' as const, ...structuredClone(found) };
    this.#messages.set(key, structuredClone(receipt));
    return { status: 'claimed' as const };
  }

  async releaseMessage(owner: string, messageId: string): Promise<void> {
    this.#messages.delete(`${owner}\n${messageId}`);
  }

  async leaseReader(conversationId: string, holder: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const lease = this.#leases.get(conversationId);
    if (lease && lease.holder !== holder && lease.until > now) return false;
    this.#leases.set(conversationId, { holder, until: now + ttlMs });
    return true;
  }

  async releaseReader(conversationId: string, holder: string): Promise<void> {
    if (this.#leases.get(conversationId)?.holder === holder) this.#leases.delete(conversationId);
  }
}

/** The tables the SQL Poppy stores keep conversations, events and message receipts in. */
export const POPPY_TABLES = {
  conversations: 'agent_poppy_conversation',
  events: 'agent_poppy_event',
  messages: 'agent_poppy_message',
} as const;
