import type {
  PoppyConnectionRecord,
  PoppyConnectionStore,
  PoppyPendingConnect,
} from '@dudousxd/nestjs-agent-core';

/** A store under test, empty. */
export interface PoppyConnectionStoreContractSubject {
  store: PoppyConnectionStore;
}

/** One behaviour every {@link PoppyConnectionStore} must have. `run` throws on the first mismatch. */
export interface PoppyConnectionStoreContractCase {
  name: string;
  run: (subject: PoppyConnectionStoreContractSubject) => Promise<void>;
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

function same(actual: unknown, expected: unknown): boolean {
  return canonical(actual) === canonical(expected);
}

const ISSUER = 'https://shop.example/poppy';

const CONNECTION: PoppyConnectionRecord = {
  owner: 'acct-1',
  issuer: ISSUER,
  domain: 'shop.example',
  organization: 'Shop',
  scope: '',
  status: 'pending',
  state: 'sealed',
  createdAt: 1,
  updatedAt: 1,
};

function pendingFixture(): PoppyPendingConnect {
  return {
    id: 'p'.repeat(32),
    owner: 'acct-1',
    domain: 'shop.example',
    issuer: ISSUER,
    organization: 'Shop',
    scope: 'poppy:read',
    actor: { id: 'u1', roles: ['member'], tenantRef: 'acct-1' },
    threadId: 't1',
    runId: 'r1',
    toolCallId: 'c1',
    flow: null,
    status: 'open',
    expiresAt: Date.now() + 60_000,
    createdAt: 1,
  };
}

/**
 * What a {@link PoppyConnectionStore} owes Poppy connections (`AgentPoppyConnectionsModule`):
 * connections upsert per (owner, issuer), list per owner and delete; a pending connect is created
 * once (a second create is a no-op), patched and read back whole. Framework-agnostic, like
 * `CHANNEL_STORE_CONTRACT`.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1.
 */
export const POPPY_CONNECTION_STORE_CONTRACT: readonly PoppyConnectionStoreContractCase[] = [
  {
    name: 'upserts connections per owner and issuer, lists and deletes them',
    async run({ store }) {
      check((await store.getConnection('acct-1', ISSUER)) === null, 'nothing yet');
      check((await store.listConnections('acct-1')).length === 0, 'no connections yet');
      await store.saveConnection(CONNECTION);
      const active = {
        ...CONNECTION,
        status: 'active' as const,
        scope: 'poppy:read',
        state: 'sealed-2',
        updatedAt: 2,
      };
      await store.saveConnection(active);
      await store.saveConnection({ ...CONNECTION, owner: 'acct-2' });
      const second = { ...CONNECTION, issuer: 'https://other.example/poppy', domain: 'other.ex' };
      await store.saveConnection(second);

      const listed = await store.listConnections('acct-1');
      const byIssuer = [...listed].sort((x, y) => (x.issuer < y.issuer ? -1 : 1));
      check(same(byIssuer, [second, active]), 'listed per owner, the upsert applied', listed);
      check(same(await store.getConnection('acct-1', ISSUER), active), 'read back');
      const other = await store.getConnection('acct-2', ISSUER);
      check(other?.status === 'pending' && other.owner === 'acct-2', 'kept apart per owner', other);

      await store.deleteConnection('acct-1', ISSUER);
      check((await store.getConnection('acct-1', ISSUER)) === null, 'deleted');
      check(same(await store.listConnections('acct-1'), [second]), 'the other issuer stays');
      check((await store.getConnection('acct-2', ISSUER)) !== null, "another owner's stays");
      await store.deleteConnection('acct-9', ISSUER); // nothing there: a no-op
    },
  },
  {
    name: 'keeps a long sealed state and a long issuer',
    async run({ store }) {
      const issuer = `https://shop.example/${'a'.repeat(400)}`;
      const state = 's'.repeat(20_000);
      await store.saveConnection({ ...CONNECTION, issuer, state });
      const read = await store.getConnection('acct-1', issuer);
      check(read?.state === state && read.issuer === issuer, 'round trip', read?.issuer);
    },
  },
  {
    name: 'creates a pending connect once, patches and reads it',
    async run({ store }) {
      const pending = pendingFixture();
      check((await store.getPending(pending.id)) === null, 'nothing yet');
      await store.createPending(pending);
      check(same(await store.getPending(pending.id), pending), 'round trip');
      await store.createPending({ ...pending, scope: 'other' }); // idempotent
      check((await store.getPending(pending.id))?.scope === 'poppy:read', 'the first create stays');

      await store.updatePending(pending.id, { status: 'connected', flow: 'x' });
      check(
        same(await store.getPending(pending.id), { ...pending, status: 'connected', flow: 'x' }),
        'patched',
        await store.getPending(pending.id),
      );
      await store.updatePending(pending.id, { flow: null });
      const cleared = await store.getPending(pending.id);
      check(cleared?.flow === null && cleared.status === 'connected', 'flow cleared', cleared);
      await store.updatePending('nope', { status: 'failed' }); // nothing there: a no-op
      check((await store.getPending('nope')) === null, 'unknown id');
    },
  },
  {
    name: 'keeps a pending connect without an actor or a turn',
    async run({ store }) {
      const pending = {
        ...pendingFixture(),
        id: 'q'.repeat(32),
        actor: null,
        threadId: null,
        runId: null,
        toolCallId: null,
        flow: 'sealed-flow',
      };
      await store.createPending(pending);
      check(same(await store.getPending(pending.id), pending), 'round trip');
    },
  },
];
