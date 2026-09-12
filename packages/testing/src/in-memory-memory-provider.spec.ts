import type { MemoryRecord, ScopeContext, StoreMemoryInput } from '@dudousxd/nestjs-agent-core';
import { GLOBAL_SCOPE, actorScope, offerMemories, tenantScope } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it } from 'vitest';
import { InMemoryMemoryProvider } from './in-memory-memory-provider.js';
import { everyMemoryField, expectedMemoryRecord } from './memory-fixture.js';

const ctx: ScopeContext = { actor: { id: 'u1', tenantRef: 'org-a' }, threadId: 't1' };
/** Somebody else entirely: another actor, in another tenant. */
const other: ScopeContext = { actor: { id: 'u2', tenantRef: 'org-b' }, threadId: 't2' };

const scopes = [actorScope(ctx.actor), tenantScope('org-a'), GLOBAL_SCOPE];

/** A human-authored write, which is the only way a record above the actor's own scope gets in. */
function published(scope: string, key: string, text: string): StoreMemoryInput {
  return { key, text, scope, origin: { author: 'human' }, ctx };
}

describe('InMemoryMemoryProvider — what a write stores', () => {
  it('round-trips every field it was handed, and mints the two it owns', () => {
    const provider = new InMemoryMemoryProvider();
    const written = everyMemoryField(ctx);

    const record = provider.write({ ...written, ctx });

    expect(record).toEqual(expectedMemoryRecord(written, record));
    expect(record.id).toBeTruthy();
    expect(new Date(record.updatedAt).getTime()).not.toBeNaN();
  });

  it('upserts on (scope, key) rather than adding a second answer to one question', () => {
    const provider = new InMemoryMemoryProvider();
    const written = everyMemoryField(ctx);

    const first = provider.write({ ...written, ctx });
    const second = provider.write({ ...written, text: 'they report on the fiscal year', ctx });

    expect(second.id).toBe(first.id);
    expect(provider.all()).toHaveLength(1);
    expect(second.text).toBe('they report on the fiscal year');
  });

  it('carries `pinned` across a rewrite of the same (scope, key)', () => {
    const provider = new InMemoryMemoryProvider();
    const written = everyMemoryField(ctx);
    const first = provider.write({ ...written, ctx });
    provider.pin({ id: first.id, pinned: true });

    const rewritten = provider.write({ ...written, text: 'restated differently', ctx });

    expect(rewritten.pinned).toBe(true);
  });

  it('refuses an agent-authored write at any scope but the actor’s own', () => {
    const provider = new InMemoryMemoryProvider();
    const written = everyMemoryField(ctx);

    expect(() => provider.write({ ...written, scope: tenantScope('org-a'), ctx })).toThrow(
      'an agent may write only at "actor:u1"',
    );
    expect(provider.all()).toEqual([]);
  });

  it('lets a human publish above it, which is what a host console does', () => {
    const provider = new InMemoryMemoryProvider();

    const record = provider.write(
      published(tenantScope('org-a'), 'units', 'report distances in kilometres'),
    );

    expect(record.scope).toBe(tenantScope('org-a'));
  });
});

describe('InMemoryMemoryProvider — scope is a gate, not a ranking signal', () => {
  it('never returns another actor’s or another tenant’s memory from `list`', () => {
    const provider = new InMemoryMemoryProvider();
    provider.write({ ...everyMemoryField(ctx), ctx });
    provider.write({ ...everyMemoryField(other), ctx: other });
    provider.write(published(tenantScope('org-b'), 'reporting-period', 'they use April to March'));

    const visible = provider.list({ scopes, ctx });

    expect(visible.map((record) => record.scope)).toEqual([actorScope(ctx.actor)]);
  });

  it('never ranks one in, even when it is the only thing the query matches', () => {
    const provider = new InMemoryMemoryProvider({ recall: true });
    provider.write(
      published(tenantScope('org-b'), 'rollback', 'roll back from the standby region'),
    );
    provider.write({ ...everyMemoryField(ctx), key: 'units', text: 'kilometres', ctx });

    const found = provider.search?.({ scopes, query: 'how do we roll back', limit: 20, ctx });

    expect(found).toEqual([]);
  });

  it('deletes only from the actor’s own scope, so an id cannot reach a wider one', () => {
    const provider = new InMemoryMemoryProvider();
    const tenantMemory = provider.write(
      published(tenantScope('org-a'), 'units', 'report distances in kilometres'),
    );

    expect(provider.forget({ id: tenantMemory.id, ctx })).toBe(false);
    expect(provider.all().map((record) => record.id)).toEqual([tenantMemory.id]);
  });

  it('answers a missing id and somebody else’s id identically', () => {
    const provider = new InMemoryMemoryProvider();
    const theirs = provider.write({ ...everyMemoryField(other), ctx: other });

    expect(provider.forget({ id: theirs.id, ctx })).toBe(false);
    expect(provider.forget({ id: 'no-such-memory', ctx })).toBe(false);
  });

  it('does delete the actor’s own', () => {
    const provider = new InMemoryMemoryProvider();
    const mine = provider.write({ ...everyMemoryField(ctx), ctx });

    expect(provider.forget({ id: mine.id, ctx })).toBe(true);
    expect(provider.all()).toEqual([]);
  });
});

describe('InMemoryMemoryProvider — recall', () => {
  it('has no `search` unless it was asked for, so a turn is read whole', async () => {
    const provider = new InMemoryMemoryProvider();

    expect(provider.search).toBeUndefined();

    const digest = await offerMemories({ config: { provider }, ctx, query: 'anything' });

    expect(digest.recalled).toBe(false);
  });

  it('returns every record sharing a ranked key, so precedence survives the search', () => {
    const provider = new InMemoryMemoryProvider({ recall: true });
    // The wider half matches the query on NOTHING — only the narrower one does. A search that
    // returned just the records it scored would drop it, and the block would then render the
    // organisation's value as the actor's own.
    provider.write(published(GLOBAL_SCOPE, 'reporting-period', 'the year starts in October'));
    provider.write({ ...everyMemoryField(ctx), ctx });

    const found = provider.search?.({ scopes, query: 'calendar', limit: 20, ctx });

    // Both halves of the conflict, or the wider value would be rendered as the answer.
    expect(found?.map((record) => record.scope).sort()).toEqual([
      actorScope(ctx.actor),
      GLOBAL_SCOPE,
    ]);
  });

  it('returns a pinned record alongside the ranked ones, matching nothing in the query', () => {
    const provider = new InMemoryMemoryProvider({ recall: true });
    const standing = provider.write(
      published(GLOBAL_SCOPE, 'cache-purge', 'never purge the config cache during business hours'),
    );
    provider.pin({ id: standing.id, pinned: true });
    provider.write({ ...everyMemoryField(ctx), key: 'timezone', text: 'they work in UTC', ctx });

    // Not one word of this is in the pinned record, so only the always-on flag can carry it in.
    const found = provider.search?.({ scopes, query: 'which timezone', limit: 20, ctx });

    expect(found?.map((record) => record.key).sort()).toEqual(['cache-purge', 'timezone']);
  });

  it('ranks the keys and takes the best `limit` of them', () => {
    const provider = new InMemoryMemoryProvider({ recall: true });
    provider.write(published(GLOBAL_SCOPE, 'a', 'rollback drains the queue first'));
    provider.write(published(GLOBAL_SCOPE, 'b', 'rollback needs two approvals'));
    provider.write(published(GLOBAL_SCOPE, 'c', 'invoices are issued monthly'));

    const found = provider.search?.({ scopes, query: 'rollback', limit: 1, ctx });

    expect(found).toHaveLength(1);
    expect(found?.[0]?.key).toBe('a');
  });

  it('returns the better match first, whatever order the records were written in', () => {
    const provider = new InMemoryMemoryProvider({ recall: true });
    // Written weakest-first, so insertion order and relevance order disagree. `resolveMemoryDigest`
    // selects by position under `ranked`, so returning these the way they were stored would hand the
    // ceiling the wrong two of three.
    provider.write(published(GLOBAL_SCOPE, 'approvals', 'a rollback needs two approvals'));
    provider.write(published(GLOBAL_SCOPE, 'runbook', 'the rollback drains the queue first'));

    const found = provider.search?.({ scopes, query: 'rollback drains', limit: 20, ctx });

    expect(found?.map((record) => record.key)).toEqual(['runbook', 'approvals']);
  });

  it('sorts a pinned record that ranked nothing behind every record that did', () => {
    const provider = new InMemoryMemoryProvider({ recall: true });
    const standing = provider.write(
      published(GLOBAL_SCOPE, 'cache-purge', 'never purge the config cache during business hours'),
    );
    provider.pin({ id: standing.id, pinned: true });
    provider.write(published(GLOBAL_SCOPE, 'runbook', 'the rollback drains the queue first'));

    const found = provider.search?.({ scopes, query: 'rollback drains', limit: 20, ctx });

    // The digest lifts pinned entries ahead of the ceiling on its own, so a pinned record placed
    // among the ranked ones would cost a slot the query actually asked for.
    expect(found?.map((record) => record.key)).toEqual(['runbook', 'cache-purge']);
  });

  it('leaves out a key nothing in the query touches', () => {
    const provider = new InMemoryMemoryProvider({ recall: true });
    provider.write(published(GLOBAL_SCOPE, 'units', 'report distances in kilometres'));

    const found = provider.search?.({ scopes, query: 'rollback', limit: 20, ctx });

    expect(found).toEqual([]);
  });
});

/**
 * A map-backed store is the one shape that CAN hand out its own objects, and a SQL adapter never
 * does — so a consumer holding this to the contract has to be able to mutate anything it was given
 * and find the store unmoved.
 */
describe('InMemoryMemoryProvider — the store and the caller never share an object', () => {
  it('does not keep reading the `origin` it was handed after the write returned', () => {
    const provider = new InMemoryMemoryProvider();
    const written = everyMemoryField(ctx);
    provider.write({ ...written, ctx });

    written.origin.runId = 'run-2';

    expect(provider.all()[0]?.origin.runId).toBe('run-1');
  });

  it('does not hand back the object it filed, so mutating a write’s result changes nothing', () => {
    const provider = new InMemoryMemoryProvider();
    const record = provider.write({ ...everyMemoryField(ctx), ctx });

    record.text = 'rewritten by the caller';
    record.origin.author = 'human';

    const stored = provider.all()[0];
    expect(stored?.text).toBe('they report on the calendar year');
    expect(stored?.origin.author).toBe('agent');
  });

  it('hands `list` a copy, so a consumer walking the results cannot rewrite the store', () => {
    const provider = new InMemoryMemoryProvider();
    provider.write({ ...everyMemoryField(ctx), ctx });

    const read = provider.list({ scopes, ctx })[0];
    if (read === undefined) {
      throw new Error('expected the actor’s own memory to be visible');
    }
    read.text = 'rewritten by the caller';
    read.origin.runId = 'run-2';

    const stored = provider.list({ scopes, ctx })[0];
    expect(stored?.text).toBe('they report on the calendar year');
    expect(stored?.origin.runId).toBe('run-1');
  });

  it('hands `all` a copy too', () => {
    const provider = new InMemoryMemoryProvider();
    provider.write({ ...everyMemoryField(ctx), ctx });

    const read = provider.all()[0];
    if (read === undefined) {
      throw new Error('expected the write to be held');
    }
    read.pinned = true;

    expect(provider.all()[0]?.pinned).toBe(false);
  });
});

describe('InMemoryMemoryProvider — pinning', () => {
  it('is nothing a write can ask for, and something the host can set and clear', () => {
    const provider = new InMemoryMemoryProvider();
    const record = provider.write({ ...everyMemoryField(ctx), ctx });
    expect(record.pinned).toBe(false);

    expect(provider.pin({ id: record.id, pinned: true })).toBe(true);
    expect(readBack(provider.list({ scopes, ctx }), record.id)?.pinned).toBe(true);

    expect(provider.pin({ id: record.id, pinned: false })).toBe(true);
    expect(readBack(provider.list({ scopes, ctx }), record.id)?.pinned).toBe(false);
  });

  it('reports a miss rather than inventing a row', () => {
    expect(new InMemoryMemoryProvider().pin({ id: 'no-such-memory', pinned: true })).toBe(false);
  });
});

function readBack(records: readonly MemoryRecord[], id: string): MemoryRecord | undefined {
  return records.find((record) => record.id === id);
}
