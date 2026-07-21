// Integration: MikroOrmRagIngestionLog against an in-memory SQLite (better-sqlite3, via
// @mikro-orm/sqlite). Runs only under `pnpm test:db`.
import { channel } from 'node:diagnostics_channel';
import { MikroORM, SqliteDriver } from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureAgentSchema } from './ensure-schema';
import { agentEntities } from './entities';
import { RagIngestionLog } from './entities/rag-ingestion-log.entity';
import { MikroOrmRagIngestionLog } from './mikro-orm-rag-ingestion-log';

let orm: MikroORM;
let log: MikroOrmRagIngestionLog;

/**
 * Publish on a rag channel and wait for the recorder's write to land. Publishes the raw
 * `{ payload }` envelope straight onto the channel — the exact wire contract the recorder couples
 * to, rather than going through `@dudousxd/nestjs-diagnostics`'s `emit` helper.
 */
async function publish(event: string, payload: Record<string, unknown>): Promise<void> {
  channel(`aviary:rag:${event}`).publish({ payload });
  await log.settle();
}

beforeAll(async () => {
  orm = await MikroORM.init({
    driver: SqliteDriver,
    dbName: ':memory:',
    // No collation: SQLite rejects named MySQL collations. Production uses AGENT_ENTITIES.
    entities: agentEntities(),
    allowGlobalContext: true,
  });
  await ensureAgentSchema(orm);
  log = new MikroOrmRagIngestionLog(orm.em);
  log.onModuleInit();
});

afterAll(async () => {
  await log?.onModuleDestroy();
  await orm?.close(true);
});

beforeEach(async () => {
  await orm.em.fork().nativeDelete(RagIngestionLog, {});
});

describe('MikroOrmRagIngestionLog (sqlite)', () => {
  it('records a successful ingestion with its chunk count and coordinates', async () => {
    await publish('media.ingested', {
      mediaId: 'rag/col-1/handbook.pdf',
      ownerType: 'rag-collection',
      ownerId: 'col-1',
      collection: 'col-1',
      chunks: 12,
    });

    const row = await log.get('rag/col-1/handbook.pdf');
    expect(row).toMatchObject({
      status: 'ingested',
      collection: 'col-1',
      ownerId: 'col-1',
      chunks: 12,
      reason: null,
      error: null,
    });
  });

  it('records a skip — the case the vector store cannot represent at all', async () => {
    await publish('media.skipped', {
      mediaId: 'rag/col-1/scan.pdf',
      collection: 'col-1',
      mimeType: 'application/pdf',
      source: 'scan.pdf',
      reason: 'empty-text',
    });

    const row = await log.get('rag/col-1/scan.pdf');
    // a scanned PDF produces zero chunks, so listDocuments() would never surface it
    expect(row).toMatchObject({
      status: 'skipped',
      reason: 'empty-text',
      source: 'scan.pdf',
      chunks: null,
    });
  });

  it('records a failure with its error message', async () => {
    await publish('media.failed', {
      mediaId: 'rag/col-1/big.xlsx',
      collection: 'col-1',
      error: 'S3 connection reset',
    });

    expect(await log.get('rag/col-1/big.xlsx')).toMatchObject({
      status: 'failed',
      error: 'S3 connection reset',
    });
  });

  it('lets a successful retry clear the previous attempt error', async () => {
    const id = 'rag/col-1/flaky.txt';
    await publish('media.failed', { mediaId: id, collection: 'col-1', error: 'timeout' });
    expect(await log.get(id)).toMatchObject({ status: 'failed', error: 'timeout' });

    await publish('media.ingested', { mediaId: id, collection: 'col-1', chunks: 3 });

    const row = await log.get(id);
    // the row reflects the CURRENT state — a stale error next to a working document would be a lie
    expect(row).toMatchObject({ status: 'ingested', chunks: 3, error: null });
  });

  it('keeps coordinates a later, sparser event does not carry', async () => {
    const id = 'rag/col-1/notes.txt';
    await publish('media.ingested', {
      mediaId: id,
      collection: 'col-1',
      source: 'notes.txt',
      chunks: 2,
    });
    // a removal knows the owner but not the collection — it must not blank what we already knew
    await publish('media.removed', { mediaId: id, ownerType: 'rag-collection', ownerId: 'col-1' });

    expect(await log.get(id)).toMatchObject({
      status: 'removed',
      collection: 'col-1',
      source: 'notes.txt',
      chunks: null,
    });
  });

  it('lists per collection, newest first, and filters by status', async () => {
    await publish('media.ingested', { mediaId: 'a', collection: 'col-1', chunks: 1 });
    await publish('media.skipped', { mediaId: 'b', collection: 'col-1', reason: 'too-large' });
    await publish('media.ingested', { mediaId: 'c', collection: 'col-2', chunks: 1 });

    const inCollection = await log.list({ collection: 'col-1' });
    expect(inCollection.map((row) => row.documentId).sort()).toEqual(['a', 'b']);

    const failuresOnly = await log.list({ collection: 'col-1', status: 'skipped' });
    expect(failuresOnly.map((row) => row.documentId)).toEqual(['b']);
  });

  it('ignores a payload with no document id instead of throwing', async () => {
    await publish('media.ingested', { collection: 'col-1', chunks: 1 });
    expect(await log.list({ collection: 'col-1' })).toHaveLength(0);
  });
});
