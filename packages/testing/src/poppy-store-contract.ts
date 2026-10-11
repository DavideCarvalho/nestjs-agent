import {
  type PoppyConversationRecord,
  type PoppyMessageReceipt,
  type PoppyStore,
  eventIdSeq,
} from '@dudousxd/nestjs-agent-core';

/** A store under test, empty. */
export interface PoppyStoreContractSubject {
  store: PoppyStore;
}

/** One behaviour every {@link PoppyStore} must have. `run` throws on the first mismatch. */
export interface PoppyStoreContractCase {
  name: string;
  run: (subject: PoppyStoreContractSubject) => Promise<void>;
}

function check(condition: boolean, message: string, actual?: unknown): void {
  if (!condition) {
    throw new Error(actual === undefined ? message : `${message} (got ${JSON.stringify(actual)})`);
  }
}

/** `value` as JSON with every object's keys sorted, so two equal values always serialize alike. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : inner,
  );
}

/** Deep equality that ignores object key order (a JSON column may normalize it). */
function same(actual: unknown, expected: unknown): boolean {
  return canonical(actual) === canonical(expected);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A conversation as a Poppy surface first creates it. */
export function poppyConversationFixture(id: string): PoppyConversationRecord {
  const now = Date.now();
  return {
    id,
    clientId: 'https://pa.example',
    userId: 'u1',
    accountRef: null,
    agentName: 'support',
    threadId: null,
    parentId: null,
    openDirectId: null,
    status: 'idle',
    responder: 'agent',
    context: { locale: 'en-US' },
    activeRunId: null,
    turnSeq: 0,
    grant: { actor: { id: 'a1', roles: ['personal_agent'] }, scopes: [], signedIn: false },
    prunedSeq: 0,
    createdAt: now,
    updatedAt: now,
  };
}

const RECEIPT: PoppyMessageReceipt = {
  fingerprint: 'f1',
  conversationId: 'cnv_1',
  response: { status: 201, body: { conversation_id: 'cnv_1', accepted: true } },
};

/**
 * What a {@link PoppyStore} owes a Personal Agent Protocol surface (`@dudousxd/nestjs-agent-poppy`):
 * conversations round-trip (JSON fields included) and patch; events append numbered after the last,
 * at most once per key and at distinct positions under concurrency, page by position and are found
 * by id; pruning keeps the last event and records how far it went; a message id is claimed once per
 * owner; the reader lease has one live holder. Framework-agnostic, like `CHANNEL_STORE_CONTRACT`:
 *
 * ```ts
 * for (const contractCase of POPPY_STORE_CONTRACT) {
 *   it(contractCase.name, async () => contractCase.run(await freshSubject()));
 * }
 * ```
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1.
 */
export const POPPY_STORE_CONTRACT: readonly PoppyStoreContractCase[] = [
  {
    name: 'creates, reads and patches a conversation, JSON fields included',
    async run({ store }) {
      const created = poppyConversationFixture('cnv_1');
      await store.createConversation(created);
      check((await store.getConversation('cnv_nope')) === null, 'an unknown id reads null');
      const read = await store.getConversation('cnv_1');
      check(same(read, created), 'round trip', read);

      const before = Date.now();
      await store.updateConversation('cnv_1', {
        status: 'working',
        accountRef: 'acct-1',
        threadId: 'thr_1',
        activeRunId: 'run_1',
        context: { locale: 'pt-BR', user_available: true, extra: { nested: [1, 'two'] } },
        grant: { actor: { id: 'acct-1', tenantRef: 't1' }, scopes: ['poppy:read'], signedIn: true },
        turnSeq: 3,
      });
      const patched = await store.getConversation('cnv_1');
      check(
        same(patched, {
          ...created,
          status: 'working',
          accountRef: 'acct-1',
          threadId: 'thr_1',
          activeRunId: 'run_1',
          context: { locale: 'pt-BR', user_available: true, extra: { nested: [1, 'two'] } },
          grant: {
            actor: { id: 'acct-1', tenantRef: 't1' },
            scopes: ['poppy:read'],
            signedIn: true,
          },
          turnSeq: 3,
          updatedAt: patched?.updatedAt,
        }),
        'patched',
        patched,
      );
      check((patched?.updatedAt ?? 0) >= before, 'a patch bumps updatedAt', patched?.updatedAt);

      // Back to null, and fields a patch leaves out keep their value.
      await store.updateConversation('cnv_1', { grant: null, activeRunId: null });
      const cleared = await store.getConversation('cnv_1');
      check(cleared?.grant === null, 'grant cleared', cleared?.grant);
      check(cleared?.activeRunId === null, 'activeRunId cleared', cleared?.activeRunId);
      check(cleared?.threadId === 'thr_1', 'threadId kept', cleared?.threadId);
      check(cleared?.agentName === 'support', 'agentName kept', cleared?.agentName);

      await store.updateConversation('cnv_nope', { status: 'closed' });
      check((await store.getConversation('cnv_nope')) === null, 'patching nothing creates nothing');
    },
  },
  {
    name: 'appends events in order, dedupes by key, finds and pages them',
    async run({ store }) {
      await store.createConversation(poppyConversationFixture('cnv_1'));
      await store.createConversation(poppyConversationFixture('cnv_2'));
      const a = await store.appendEvent('cnv_1', {
        type: 'state',
        status: 'working',
        responder: 'agent',
      });
      const b = await store.appendEvent(
        'cnv_1',
        { type: 'user_requested', reason: 'x' },
        { key: 'once' },
      );
      const again = await store.appendEvent(
        'cnv_1',
        { type: 'user_requested', reason: 'y' },
        { key: 'once' },
      );
      check(a.created && b.created, 'first appends are created');
      check(again.created === false, 'a second append with the key is not created');
      check(again.event.event.id === b.event.event.id, 'it answers the first event', again);
      check(again.event.seq === 2 && again.event.event.reason === 'x', 'unchanged', again);
      check(same([a.event.seq, b.event.seq], [1, 2]), 'positions', [a.event.seq, b.event.seq]);
      check(eventIdSeq(b.event.event.id) === 2, 'the id carries its position', b.event.event.id);
      check(
        typeof a.event.event.created_at === 'string' &&
          !Number.isNaN(Date.parse(a.event.event.created_at)),
        'created_at is an ISO time',
        a.event.event.created_at,
      );

      // Another conversation numbers on its own, and its keys are its own.
      const other = await store.appendEvent(
        'cnv_2',
        { type: 'user_requested', reason: 'z' },
        { key: 'once' },
      );
      check(other.created && other.event.seq === 1, 'per-conversation positions', other);

      const all = await store.listEvents('cnv_1', 0, 10);
      check(
        same(all, [a.event, b.event]),
        'listed in order, as appended',
        all.map((e) => e.event),
      );
      const after = await store.listEvents('cnv_1', 1, 10);
      check(after.length === 1 && after[0]?.seq === 2, 'after a position', after);
      const page = await store.listEvents('cnv_1', 0, 1);
      check(page.length === 1 && page[0]?.seq === 1, 'at most limit', page);
      check((await store.listEvents('cnv_x', 0, 10)).length === 0, 'unknown conversation: none');

      check((await store.findEventSeq('cnv_1', b.event.event.id)) === 2, 'found by id');
      check(
        (await store.findEventSeq('cnv_2', b.event.event.id)) === null,
        'not in another conversation',
      );
      check((await store.findEventSeq('cnv_1', 'evt_zz_nope')) === null, 'unknown id');
    },
  },
  {
    name: 'gives concurrent appends distinct positions',
    async run({ store }) {
      await store.createConversation(poppyConversationFixture('cnv_1'));
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          store.appendEvent('cnv_1', { type: 'user_requested', reason: String(i) }),
        ),
      );
      check(
        same(
          [...results.map((r) => r.event.seq)].sort((x, y) => x - y),
          [1, 2, 3, 4, 5, 6, 7, 8],
        ),
        'appended positions',
        results.map((r) => r.event.seq),
      );
      const seqs = (await store.listEvents('cnv_1', 0, 100)).map((e) => e.seq);
      check(same(seqs, [1, 2, 3, 4, 5, 6, 7, 8]), 'listed positions', seqs);
      const reasons = (await store.listEvents('cnv_1', 0, 100)).map((e) => e.event.reason);
      check(new Set(reasons).size === 8, 'every append kept', reasons);
    },
  },
  {
    name: 'appends one event per key under concurrency',
    async run({ store }) {
      await store.createConversation(poppyConversationFixture('cnv_1'));
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          store.appendEvent(
            'cnv_1',
            { type: 'user_requested', reason: String(i) },
            { key: 'reply:run_1' },
          ),
        ),
      );
      check(results.filter((r) => r.created).length === 1, 'one created', results);
      check(
        new Set(results.map((r) => r.event.event.id)).size === 1,
        'all answer the same event',
        results.map((r) => r.event.event.id),
      );
      check((await store.listEvents('cnv_1', 0, 100)).length === 1, 'one event stored');
    },
  },
  {
    name: 'prunes old events but keeps the last, and remembers how far',
    async run({ store }) {
      await store.createConversation(poppyConversationFixture('cnv_1'));
      const appended = [];
      for (let i = 0; i < 3; i++) {
        appended.push(
          await store.appendEvent('cnv_1', { type: 'user_requested', reason: String(i) }),
        );
      }
      // Nothing is old yet: nothing goes.
      await store.pruneEvents('cnv_1', Date.now() - 60_000);
      check((await store.listEvents('cnv_1', 0, 10)).length === 3, 'nothing old to prune');
      check((await store.getConversation('cnv_1'))?.prunedSeq === 0, 'prunedSeq untouched');

      await store.pruneEvents('cnv_1', Date.now() + 1000);
      const left = (await store.listEvents('cnv_1', 0, 10)).map((e) => e.seq);
      check(same(left, [3]), 'the last is kept', left);
      const pruned = (await store.getConversation('cnv_1'))?.prunedSeq;
      check(pruned === 2, 'prunedSeq', pruned);
      check(
        (await store.findEventSeq('cnv_1', appended[0]?.event.event.id ?? '')) === null,
        'a pruned event is not found',
      );
      const next = await store.appendEvent('cnv_1', { type: 'user_requested', reason: 'n' });
      check(next.event.seq === 4, 'the next position continues', next.event.seq);
      await store.pruneEvents('cnv_x', Date.now() + 1000); // unknown conversation: a no-op
    },
  },
  {
    name: 'claims a message id once per owner, and releases it',
    async run({ store }) {
      check(
        same(await store.claimMessage('owner', 'msg_1', RECEIPT), { status: 'claimed' }),
        'first claim',
      );
      const second = await store.claimMessage('owner', 'msg_1', { ...RECEIPT, fingerprint: 'f2' });
      check(same(second, { status: 'existing', ...RECEIPT }), 'the first receipt answers', second);
      check(
        (await store.claimMessage('other', 'msg_1', RECEIPT)).status === 'claimed',
        'another owner claims the same id',
      );
      await store.releaseMessage('owner', 'msg_1');
      check(
        (await store.claimMessage('owner', 'msg_1', RECEIPT)).status === 'claimed',
        'claimed again after release',
      );
    },
  },
  {
    name: 'lets exactly one of several concurrent claims of a message through',
    async run({ store }) {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          store.claimMessage('owner', 'msg_race', { ...RECEIPT, fingerprint: `f${i}` }),
        ),
      );
      check(results.filter((r) => r.status === 'claimed').length === 1, 'winners', results);
    },
  },
  {
    name: 'leases the reader to one holder at a time',
    async run({ store }) {
      await store.createConversation(poppyConversationFixture('cnv_1'));
      check((await store.leaseReader('cnv_1', 'a', 60_000)) === true, 'a takes it');
      check((await store.leaseReader('cnv_1', 'b', 60_000)) === false, 'b waits');
      check((await store.leaseReader('cnv_1', 'a', 60_000)) === true, 'a renews');
      await store.releaseReader('cnv_1', 'b'); // not b's to release
      check((await store.leaseReader('cnv_1', 'b', 60_000)) === false, 'still a');
      await store.releaseReader('cnv_1', 'a');
      check((await store.leaseReader('cnv_1', 'b', 1)) === true, 'b after release');
      await sleep(20);
      check((await store.leaseReader('cnv_1', 'a', 60_000)) === true, 'a after expiry');
    },
  },
  {
    name: 'gives a free reader lease to exactly one of several concurrent takers',
    async run({ store }) {
      await store.createConversation(poppyConversationFixture('cnv_1'));
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => store.leaseReader('cnv_1', `h${i}`, 60_000)),
      );
      check(results.filter(Boolean).length === 1, 'holders', results);
    },
  },
];
