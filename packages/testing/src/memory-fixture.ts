import type {
  MemoryOrigin,
  MemoryRecord,
  ScopeContext,
  StoreMemoryInput,
} from '@dudousxd/nestjs-agent-core';
import { actorScope } from '@dudousxd/nestjs-agent-core';

/**
 * Everything a `write` is handed, all populated — including every optional field of the origin.
 *
 * Typed `Required<…>` so a new field on `StoreMemoryInput` or on {@link MemoryOrigin} fails to
 * COMPILE here until it is filled in, which is what then forces every adapter's round-trip spec to
 * prove the field survives a column. That is earlier than any assertion: an origin field an adapter
 * silently drops is invisible to a test that asserts only on the fields someone remembered.
 *
 * Exported from the testing package on purpose, like {@link EVERY_MESSAGE_FIELD}: a consumer writing
 * its own `MemoryProvider` should be able to hold it to the same contract.
 */
export type EveryMemoryField = Required<Omit<StoreMemoryInput, 'ctx'>> & {
  origin: Required<MemoryOrigin>;
};

/**
 * The fixture for `ctx`'s own turn. The scope is the ACTOR'S OWN because that is the only one an
 * agent-authored write may use — a fixture at a wider scope would be testing the refusal, not the
 * round trip.
 */
export function everyMemoryField(ctx: ScopeContext, runId = 'run-1'): EveryMemoryField {
  return {
    key: 'reporting-period',
    text: 'they report on the calendar year',
    scope: actorScope(ctx.actor),
    origin: {
      author: 'agent',
      threadId: ctx.threadId,
      runId,
      actorRef: ctx.actor.id,
    },
  };
}

/**
 * The record that write must return: the fixture, plus the two fields the store mints. Read back off
 * the returned record because an id and a timestamp are the adapter's to choose — every field the
 * CALLER supplied is asserted against what it supplied.
 *
 * `Required<MemoryRecord>` for the same compile-time reason as {@link EveryMemoryField}, applied to
 * the read shape: `pinned` is optional on the SPI, and an adapter that omitted it would leave a
 * read-back unable to tell "not pinned" from "this store does not track pinning".
 */
export function expectedMemoryRecord(
  written: EveryMemoryField,
  minted: Pick<MemoryRecord, 'id' | 'updatedAt'>,
): Required<MemoryRecord> {
  return { ...written, id: minted.id, updatedAt: minted.updatedAt, pinned: false };
}
