import {
  type ConfirmTokenStore,
  createNoopEmitUi,
  defineConfirmedTool,
  hashConfirmToken,
} from '@dudousxd/nestjs-agent-core';

/** A store under test, plus a way to read back the hashes it holds (whatever its table). */
export interface ConfirmTokenContractSubject {
  store: ConfirmTokenStore;
  /** Every row the store keeps, as stored — used to prove only the hash, never the token, is kept. */
  rows(): Promise<Record<string, unknown>[]>;
}

/** One behaviour every {@link ConfirmTokenStore} must have. `run` throws on the first mismatch. */
export interface ConfirmTokenContractCase {
  name: string;
  run: (subject: ConfirmTokenContractSubject) => Promise<void>;
}

function check(condition: boolean, message: string, actual?: unknown): void {
  if (!condition) {
    throw new Error(actual === undefined ? message : `${message} (got ${JSON.stringify(actual)})`);
  }
}

const claim = (hash: string, expiresAt = Date.now() + 60_000) => ({
  hash,
  actorRef: 'u1',
  tool: 'refund_order',
  expiresAt,
});

/**
 * What a {@link ConfirmTokenStore} owes `defineConfirmedTool`: a hash goes to the first claim only,
 * atomically under concurrency; a release gives it back; expired marks purge; and only the token's
 * hash is ever stored. Framework-agnostic, like `CHAT_QUEUE_STORE_CONTRACT`:
 *
 * ```ts
 * for (const contractCase of CONFIRM_TOKEN_STORE_CONTRACT) {
 *   it(contractCase.name, async () => contractCase.run(await freshSubject()));
 * }
 * ```
 */
export const CONFIRM_TOKEN_STORE_CONTRACT: readonly ConfirmTokenContractCase[] = [
  {
    name: 'gives a hash to the first claim only',
    async run({ store }) {
      check((await store.claim(claim('h1'))) === true, 'first claim');
      check((await store.claim(claim('h1'))) === false, 'second claim of the same hash');
      check((await store.claim(claim('h2'))) === true, 'another hash');
    },
  },
  {
    name: 'lets exactly one of several concurrent claims through',
    async run({ store }) {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => store.claim(claim('race'))),
      );
      check(results.filter(Boolean).length === 1, 'winners', results);
    },
  },
  {
    name: 'a released hash can be claimed again',
    async run({ store }) {
      await store.claim(claim('h1'));
      await store.release('h1');
      check((await store.claim(claim('h1'))) === true, 'claim after release');
    },
  },
  {
    name: 'purges only what expired, and says how many',
    async run({ store, rows }) {
      const now = Date.now();
      await store.claim(claim('old-1', now + 1_000));
      await store.claim(claim('old-2', now + 2_000));
      await store.claim(claim('live', now + 60_000));
      check((await store.purgeExpired?.(now + 5_000)) === 2, 'first purge');
      check((await store.purgeExpired?.(now + 5_000)) === 0, 'second purge');
      const left = (await rows()).map((row) => row.hash);
      check(left.length === 1 && left[0] === 'live', 'rows left', left);
    },
  },
  {
    name: 'makes a confirmed tool single use, keyed by the hash of the token',
    async run({ store, rows }) {
      let commits = 0;
      const tool = defineConfirmedTool<{ id: string }, { id: string }>(
        {
          name: 'archive',
          description: 'Archive.',
          input: {
            '~standard': {
              version: 1,
              vendor: 'contract',
              validate: (value: unknown) => ({ value: value as { id: string } }),
            },
          },
          secret: 'a-secret',
          store,
        },
        {
          prepare: (args) => args,
          preview: () => ({ summary: 'Archive?' }),
          commit: () => {
            commits += 1;
            return { summary: 'Archived.' };
          },
        },
      );
      const ctx = {
        actor: { id: 'u1' },
        threadId: 't',
        runId: 'r',
        requestId: 'q',
        emitUi: createNoopEmitUi('q'),
      };
      const preview = (await tool.handler.execute({ id: 'a' }, ctx)) as { confirmToken: string };
      const confirm = { id: 'a', confirm: true, confirmToken: preview.confirmToken };
      await tool.handler.execute(confirm, ctx);
      let refused = false;
      try {
        await tool.handler.execute(confirm, ctx);
      } catch (error) {
        refused = /already confirmed/.test(String(error));
      }
      check(refused, 'second confirmation refused as already confirmed');
      check(commits === 1, 'commits', commits);
      const stored = await rows();
      const hashes = stored.map((row) => row.hash);
      check(
        hashes.length === 1 && hashes[0] === hashConfirmToken(preview.confirmToken),
        'stored hashes',
        hashes,
      );
      check(
        !JSON.stringify(stored).includes(preview.confirmToken),
        'the token itself is not stored',
      );
    },
  },
];
