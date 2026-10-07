import type { ChannelStore } from '@dudousxd/nestjs-agent-core';

/** A store under test. */
export interface ChannelStoreContractSubject {
  store: ChannelStore;
}

/** One behaviour every {@link ChannelStore} must have. `run` throws on the first mismatch. */
export interface ChannelStoreContractCase {
  name: string;
  run: (subject: ChannelStoreContractSubject) => Promise<void>;
}

function check(condition: boolean, message: string, actual?: unknown): void {
  if (!condition) {
    throw new Error(actual === undefined ? message : `${message} (got ${JSON.stringify(actual)})`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What a {@link ChannelStore} owes the text channels (`@dudousxd/nestjs-agent-channels`): a key goes
 * to the first claim only, atomically under concurrency, and is free again once it expired or was
 * deleted; values round-trip, are replaced and expire; keys of any length are kept apart.
 * Framework-agnostic, like `CONFIRM_TOKEN_STORE_CONTRACT`:
 *
 * ```ts
 * for (const contractCase of CHANNEL_STORE_CONTRACT) {
 *   it(contractCase.name, async () => contractCase.run(await freshSubject()));
 * }
 * ```
 */
export const CHANNEL_STORE_CONTRACT: readonly ChannelStoreContractCase[] = [
  {
    name: 'gives a key to the first claim only',
    async run({ store }) {
      check((await store.claim('telegram:1', 60_000)) === true, 'first claim');
      check((await store.claim('telegram:1', 60_000)) === false, 'second claim of the same key');
      check((await store.claim('telegram:2', 60_000)) === true, 'another key');
    },
  },
  {
    name: 'lets exactly one of several concurrent claims through',
    async run({ store }) {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => store.claim('race', 60_000)),
      );
      check(results.filter(Boolean).length === 1, 'winners', results);
    },
  },
  {
    name: 'frees a key once its claim expired, or was deleted',
    async run({ store }) {
      check((await store.claim('short', 40)) === true, 'first claim');
      await sleep(80);
      check((await store.claim('short', 60_000)) === true, 'claim after expiry');
      await store.delete('short');
      check((await store.claim('short', 60_000)) === true, 'claim after delete');
    },
  },
  {
    name: 'stores, replaces, expires and deletes values',
    async run({ store }) {
      check((await store.get('missing')) === null, 'a missing key reads null');
      await store.claim('claimed', 60_000);
      check((await store.get('claimed')) === null, 'a claimed key holds no value');
      await store.set('q', '{"index":0}', 60_000);
      check((await store.get('q')) === '{"index":0}', 'round trip', await store.get('q'));
      await store.set('q', '{"index":1}', 60_000);
      check((await store.get('q')) === '{"index":1}', 'replaced', await store.get('q'));
      check((await store.claim('q', 60_000)) === false, 'a set key is taken');
      await store.delete('q');
      check((await store.get('q')) === null, 'deleted');
      await store.set('brief', 'x', 40);
      await sleep(80);
      check((await store.get('brief')) === null, 'expired value');
    },
  },
  {
    name: 'keeps long keys apart',
    async run({ store }) {
      const base = `whatsapp:question:${'5'.repeat(300)}`;
      check((await store.claim(`${base}:a`, 60_000)) === true, 'first long key');
      check((await store.claim(`${base}:b`, 60_000)) === true, 'second long key');
      check((await store.claim(`${base}:a`, 60_000)) === false, 'first long key again');
      await store.set(`${base}:c`, 'value', 60_000);
      check((await store.get(`${base}:c`)) === 'value', 'long key value');
    },
  },
  {
    name: 'purges expired entries, when it can',
    async run({ store }) {
      if (store.purgeExpired === undefined) return;
      await store.claim('old', 20);
      await store.set('keep', 'v', 60_000);
      await sleep(50);
      check((await store.purgeExpired()) >= 1, 'purged at least the expired key');
      check((await store.get('keep')) === 'v', 'a live key survives');
    },
  },
];
