// Integration: MikroOrmRagIngestionLog on SQLite, Postgres and MySQL.
// Runs only under `pnpm test:db`.
import { channel } from 'node:diagnostics_channel';
import type { MikroORM } from '@mikro-orm/sqlite';
import { type DynamicModule, Logger } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAgentSchema } from './ensure-schema';
import { agentEntities } from './entities';
import {
  RagIngestionLog,
  RagIngestionLogRepository,
  type RagIngestionStatus,
} from './entities/rag-ingestion-log.entity';
import { MikroOrmAgentStoreModule } from './mikro-orm-agent-store.module';
import {
  MikroOrmRagIngestionLog,
  RAG_INGESTION_LOG_PAGE_ORDER,
} from './mikro-orm-rag-ingestion-log';
import { describeEachDialect, openFreshOrm } from './testing/real-db';

describeEachDialect('MikroOrmRagIngestionLog', (dialect) => {
  let orm: MikroORM;
  let log: MikroOrmRagIngestionLog;

  const EPOCH = Date.parse('2026-01-01T00:00:00Z');

  /**
   * Insert rows straight into the table rather than through the diagnostics channel: these sweep
   * tests need dozens of rows with *controlled* `updatedAt` values, and the recorder deliberately
   * stamps `now`.
   */
  async function seed(
    count: number,
    options: {
      collection?: string;
      status?: RagIngestionStatus;
      sameUpdatedAt?: boolean;
      prefix?: string;
    } = {},
  ): Promise<string[]> {
    const prefix = options.prefix ?? 'doc';
    const ids = Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(3, '0')}`);
    await orm.em.fork().insertMany(
      RagIngestionLog,
      ids.map((documentId, i) => ({
        documentId,
        status: options.status ?? ('ingested' as RagIngestionStatus),
        collection: options.collection ?? 'col-1',
        chunks: 1,
        createdAt: new Date(EPOCH),
        // distinct timestamps by default; all-tied when the test is about the tiebreaker
        updatedAt: new Date(options.sameUpdatedAt === true ? EPOCH : EPOCH + i * 1000),
      })),
    );
    return ids;
  }

  /** Insert one extra row with a hand-picked `updatedAt`, to land it before or after a live cursor. */
  async function insertAt(
    documentId: string,
    updatedAt: Date,
    collection = 'col-1',
  ): Promise<void> {
    await orm.em.fork().insert(RagIngestionLog, {
      documentId,
      status: 'ingested' as RagIngestionStatus,
      collection,
      chunks: 1,
      createdAt: updatedAt,
      updatedAt,
    });
  }

  /** The ids currently in the table, in the paging order. */
  async function idsInOrder(): Promise<string[]> {
    const rows = await orm.em
      .fork()
      .find(RagIngestionLog, {}, { orderBy: RAG_INGESTION_LOG_PAGE_ORDER });
    return rows.map((row) => row.documentId);
  }

  /** Every SQL statement the ORM has run since {@link recordQueries} was last called. */
  let queries: string[] = [];
  function recordQueries(): string[] {
    queries = [];
    return queries;
  }

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
    orm = await openFreshOrm(dialect, {
      // Captured, not printed: one test asserts on the columns listDocumentIds actually selects.
      debug: ['query'],
      logger: (message: string) => {
        queries.push(message);
      },
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

  /** Whether the module's provider list actually binds the recorder, not just re-exports the name. */
  function bindsRecorder(module: DynamicModule): boolean {
    return (module.providers ?? []).some(
      (provider) =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === MikroOrmRagIngestionLog,
    );
  }

  describe('MikroOrmAgentStoreModule wiring', () => {
    it('binds and exports the recorder by default, matching the Drizzle adapter', () => {
      const module = MikroOrmAgentStoreModule.forFeature();

      expect(bindsRecorder(module)).toBe(true);
      expect(module.exports).toContain(MikroOrmRagIngestionLog);
    });

    it('binds nothing at all when ragIngestionLog is off', () => {
      const module = MikroOrmAgentStoreModule.forFeature({ ragIngestionLog: false });

      // a host that records outcomes itself gets no second writer, and no subscriber on the channel
      expect(bindsRecorder(module)).toBe(false);
      expect(module.exports).not.toContain(MikroOrmRagIngestionLog);
    });
  });

  describe('RagIngestionLog custom repository', () => {
    it('is what a booted ORM hands back for the entity', () => {
      // The point of wiring `repository` into the schema: a host resolves the repository by type
      // (`em.getRepository(RagIngestionLog)`, `@InjectRepository`) instead of threading the entity
      // through every `em.find(RagIngestionLog, …)` call.
      const repository = orm.em.fork().getRepository(RagIngestionLog);
      expect(repository).toBeInstanceOf(RagIngestionLogRepository);
    });

    it('reads the same rows the entity manager does', async () => {
      await seed(3);

      const rows = await orm.em.fork().getRepository(RagIngestionLog).findAll();
      expect(rows.map((row) => row.documentId).sort()).toEqual(['doc-000', 'doc-001', 'doc-002']);
    });
  });

  describe('MikroOrmRagIngestionLog', () => {
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

    it('records nothing at all once it has been torn down', async () => {
      await log.onModuleDestroy();
      try {
        await publish('media.ingested', {
          mediaId: 'after-teardown',
          collection: 'col-1',
          chunks: 1,
        });

        // the row can only be here because THIS event was observed — nothing else writes the table
        expect(await log.get('after-teardown')).toBeNull();
      } finally {
        log.onModuleInit();
      }
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

    it('keeps the first-attempt createdAt across a re-ingest, and moves updatedAt', async () => {
      const id = 'rag/col-1/rewritten.txt';
      await publish('media.failed', { mediaId: id, collection: 'col-1', error: 'timeout' });
      const first = await log.get(id);

      await publish('media.ingested', { mediaId: id, collection: 'col-1', chunks: 3 });

      const second = await log.get(id);
      // createdAt answers "when was this document first attempted?" — an upsert that overwrote it
      // would make every row look as new as its last retry
      expect(second?.createdAt).toEqual(first?.createdAt);
      expect(second?.updatedAt.getTime()).toBeGreaterThanOrEqual(first?.updatedAt.getTime() ?? 0);
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
      await publish('media.removed', {
        mediaId: id,
        ownerType: 'rag-collection',
        ownerId: 'col-1',
      });

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

    it('pages, and reports the unpaginated total alongside the page', async () => {
      for (const id of ['a', 'b', 'c']) {
        await publish('media.ingested', { mediaId: id, collection: 'col-1', chunks: 1 });
      }

      const page = await log.listPage({ collection: 'col-1', limit: 2 });
      expect(page.rows).toHaveLength(2);
      // the point: 2 rows returned but 3 exist, so a caller can say so instead of implying completeness
      expect(page.total).toBe(3);

      const second = await log.listPage({ collection: 'col-1', limit: 2, offset: 2 });
      expect(second.rows).toHaveLength(1);
      expect(second.total).toBe(3);
    });

    it('counts the whole filter, not the page, when reporting the total', async () => {
      await seed(4, { collection: 'col-1' });
      await seed(3, { collection: 'col-2', prefix: 'other' });

      // a total that leaked the other collection in would read as 7 and mislead every caller
      expect((await log.listPage({ collection: 'col-1', limit: 2 })).total).toBe(4);
      expect((await log.listPage({ collection: 'col-2', limit: 2 })).total).toBe(3);
    });

    it('pages a batch sharing one updatedAt without dropping or repeating a row', async () => {
      // inserted out of alphabetical order on purpose: insertion order must not be what decides the
      // page boundaries, only the declared tiebreaker may
      const inserted = ['doc-c', 'doc-a', 'doc-e', 'doc-b', 'doc-d'];
      for (const id of inserted) {
        await publish('media.ingested', { mediaId: id, collection: 'col-1', chunks: 1 });
      }
      // a bulk upload stamps the whole batch with the same second, so every row ties on the ordering
      // column and only the tiebreaker keeps consecutive pages disjoint
      await orm.em
        .fork()
        .nativeUpdate(RagIngestionLog, {}, { updatedAt: new Date('2026-01-01T00:00:00Z') });

      const paged: string[] = [];
      const listed: string[] = [];
      for (let offset = 0; offset < inserted.length; offset += 2) {
        const page = await log.listPage({ collection: 'col-1', limit: 2, offset });
        expect(page.total).toBe(inserted.length);
        paged.push(...page.rows.map((row) => row.documentId));
        const rows = await log.list({ collection: 'col-1', limit: 2, offset });
        listed.push(...rows.map((row) => row.documentId));
      }

      const byTiebreaker = [...inserted].sort();
      // the guarantee that was broken: a sweep sees every row exactly once — none lost between two
      // pages, none returned twice — which is what makes an orphan sweep or a reconcile correct
      expect(paged.slice().sort()).toEqual(byTiebreaker);
      expect(listed.slice().sort()).toEqual(byTiebreaker);
      // and the reason it holds: with the ordering column fully tied, the primary key alone decides
      // the sequence, so consecutive pages cannot overlap or leave a gap
      expect(paged).toEqual(byTiebreaker);
      expect(listed).toEqual(byTiebreaker);
    });

    it('removes one document record, and reports whether there was one', async () => {
      await publish('media.ingested', { mediaId: 'gone', collection: 'col-1', chunks: 1 });

      expect(await log.remove('gone')).toBe(true);
      expect(await log.get('gone')).toBeNull();
      expect(await log.remove('gone')).toBe(false);
    });

    it('removes every record of a collection, leaving other collections alone', async () => {
      await publish('media.ingested', { mediaId: 'x', collection: 'col-1', chunks: 1 });
      await publish('media.ingested', { mediaId: 'y', collection: 'col-1', chunks: 1 });
      await publish('media.ingested', { mediaId: 'z', collection: 'col-2', chunks: 1 });

      expect(await log.removeByCollection('col-1')).toBe(2);
      expect(await log.list({ collection: 'col-1' })).toHaveLength(0);
      expect(await log.list({ collection: 'col-2' })).toHaveLength(1);
    });

    it('ignores a payload with no document id instead of throwing', async () => {
      await publish('media.ingested', { collection: 'col-1', chunks: 1 });
      expect(await log.list({ collection: 'col-1' })).toHaveLength(0);
    });

    it('reports a write failure instead of letting it escape the recorder', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      // the table is out of reach, so the upsert throws
      const connection = orm.em.getConnection();
      await connection.execute('alter table rag_ingestion_log rename to rag_ingestion_log_hidden');
      let warned: unknown[][] = [];
      try {
        await publish('media.ingested', { mediaId: 'doomed', collection: 'col-1', chunks: 1 });
        warned = warn.mock.calls.map((call) => [...call]);
      } finally {
        warn.mockRestore();
        await connection.execute(
          'alter table rag_ingestion_log_hidden rename to rag_ingestion_log',
        );
      }

      // the write is best-effort: it runs detached on a diagnostics channel, so a failed one has
      // nothing to fail — it is reported and dropped, and the ingestion that published is untouched
      expect(warned).toHaveLength(1);
      expect(String(warned[0]?.[0])).toContain('doomed');
      expect(await log.get('doomed')).toBeNull();
    });

    it('lets a caller override the page order without changing the default', async () => {
      const ids = await seed(5);

      const byDefault = await log.listPage({ limit: 5 });
      // the documented default, spelled out: newest first
      expect(byDefault.rows.map((row) => row.documentId)).toEqual([...ids].reverse());
      // passing the exported constant explicitly is a no-op — it IS the default
      const explicit = await log.listPage({ limit: 5, orderBy: RAG_INGESTION_LOG_PAGE_ORDER });
      expect(explicit.rows.map((row) => row.documentId)).toEqual([...ids].reverse());

      // and an override actually takes effect, so a caller no longer has to bypass the class to sort
      const overridden = await log.listPage({ limit: 5, orderBy: { documentId: 'asc' } });
      expect(overridden.rows.map((row) => row.documentId)).toEqual(ids);
      expect(overridden.total).toBe(5);
    });
  });

  describe('MikroOrmRagIngestionLog.iterate (keyset sweep)', () => {
    it('walks every row exactly once across many batches', async () => {
      const ids = await seed(25);

      const visited: string[] = [];
      for await (const row of log.iterate({}, { batchSize: 4 })) {
        visited.push(row.documentId);
      }

      // 25 rows over batches of 4 = 7 round-trips, so every boundary case is exercised
      expect(visited).toEqual([...ids].reverse());
      expect(new Set(visited).size).toBe(ids.length);
    });

    // THE test this API exists for. Offset paging cannot survive this: every deleted row shifts the
    // rest back by one, so the next OFFSET lands past rows nobody ever saw. A keyset cursor is column
    // values read off a row already in memory, so removing rows moves nothing.
    it('visits every row exactly once while the sweep deletes each row it visits', async () => {
      const ids = await seed(30);

      const visited: string[] = [];
      for await (const row of log.iterate({}, { batchSize: 7 })) {
        visited.push(row.documentId);
        // the reconcile shape: process a row, then drop it — the table drains under the cursor
        expect(await log.remove(row.documentId)).toBe(true);
      }

      expect(visited).toEqual([...ids].reverse());
      expect(new Set(visited).size).toBe(30);
      expect(await idsInOrder()).toEqual([]);
    });

    it('does the same when every row shares one updatedAt — the tiebreaker case', async () => {
      // a bulk upload stamps the whole batch with one timestamp, so the ordering column is useless and
      // only the primary-key tiebreaker keeps consecutive batches disjoint
      const ids = await seed(30, { sameUpdatedAt: true });

      const visited: string[] = [];
      for await (const row of log.iterate({}, { batchSize: 7 })) {
        visited.push(row.documentId);
        await log.remove(row.documentId);
      }

      // fully tied on updatedAt, so the order is the tiebreaker alone: documentId ascending
      expect(visited).toEqual(ids);
      expect(new Set(visited).size).toBe(30);
      expect(await idsInOrder()).toEqual([]);
    });

    it('skips rows deleted ahead of the cursor and still visits every survivor once', async () => {
      await seed(20);
      // rows the sweep has not reached yet, chosen to straddle and to empty a later batch entirely
      const deletedAhead = [
        'doc-011',
        'doc-010',
        'doc-004',
        'doc-003',
        'doc-002',
        'doc-001',
        'doc-000',
      ];

      const visited: string[] = [];
      for await (const row of log.iterate({}, { batchSize: 5 })) {
        if (visited.length === 0) {
          for (const id of deletedAhead) {
            await log.remove(id);
          }
        }
        visited.push(row.documentId);
      }

      // every survivor exactly once, nothing deleted, and no gap where the deletions were
      expect(visited).toEqual(await idsInOrder());
      expect(visited).toHaveLength(13);
      expect(visited.filter((id) => deletedAhead.includes(id))).toEqual([]);
    });

    it('resumes from a cursor an earlier sweep stopped on', async () => {
      const ids = await seed(10);

      const first: string[] = [];
      let cursor = { updatedAt: new Date(0), documentId: '' };
      for await (const row of log.iterate({}, { batchSize: 3 })) {
        first.push(row.documentId);
        cursor = { updatedAt: row.updatedAt, documentId: row.documentId };
        // stop mid-batch: the cursor must be the last row actually seen, not the last row fetched
        if (first.length === 4) {
          break;
        }
      }

      const rest: string[] = [];
      for await (const row of log.iterate({}, { batchSize: 3, after: cursor })) {
        rest.push(row.documentId);
      }

      // the two halves partition the table: no row seen twice, none lost at the seam
      expect([...first, ...rest]).toEqual([...ids].reverse());
    });

    it('does not visit a row a concurrent ingest inserts behind the cursor', async () => {
      const ids = await seed(10);

      const visited: string[] = [];
      for await (const row of log.iterate({}, { batchSize: 3 })) {
        visited.push(row.documentId);
        if (visited.length === 2) {
          // record() always stamps `now`, so a concurrent ingest lands NEWEST — i.e. at a position the
          // sweep has already gone past. An orphan sweep must not treat it as an orphan.
          await insertAt('ingested-mid-sweep', new Date(EPOCH + 1_000_000));
          // the mirror image, spelled out because the doc comment claims it: a backdated write lands
          // ahead of the cursor and IS visited. Nothing in this class produces one.
          await insertAt('backdated-mid-sweep', new Date(EPOCH - 1_000));
        }
      }

      expect(visited).not.toContain('ingested-mid-sweep');
      expect(visited).toEqual([...[...ids].reverse(), 'backdated-mid-sweep']);
    });

    it('honours the collection and status filters per batch', async () => {
      await seed(6, { collection: 'col-1' });
      await seed(6, { collection: 'col-2', prefix: 'other' });
      await orm.em
        .fork()
        .nativeUpdate(RagIngestionLog, { documentId: 'doc-002' }, { status: 'failed' });

      const inCollection: string[] = [];
      for await (const row of log.iterate({ collection: 'col-1' }, { batchSize: 2 })) {
        inCollection.push(row.documentId);
      }
      expect(inCollection).toEqual([
        'doc-005',
        'doc-004',
        'doc-003',
        'doc-002',
        'doc-001',
        'doc-000',
      ]);

      const failures: string[] = [];
      for await (const row of log.iterate({ collection: 'col-1', status: 'failed' })) {
        failures.push(row.documentId);
      }
      expect(failures).toEqual(['doc-002']);
    });

    it('clamps a nonsense batch size instead of spinning forever', async () => {
      const ids = await seed(3);

      const visited: string[] = [];
      // 0 rows per round-trip would make the sweep fetch nothing and never advance
      for await (const row of log.iterate({}, { batchSize: 0 })) {
        visited.push(row.documentId);
      }

      expect(visited).toEqual([...ids].reverse());
    });
  });

  describe('MikroOrmRagIngestionLog.listDocumentIds', () => {
    it('returns every id, past the row cap list() stops at', async () => {
      const ids = await seed(250);

      // the reason this method exists: list() truncates, and a sweep built on it silently under-reports
      expect(await log.list()).toHaveLength(200);

      const documentIds = await log.listDocumentIds({ collection: 'col-1' }, { batchSize: 60 });
      expect(documentIds).toHaveLength(250);
      expect(documentIds).toEqual([...ids].reverse());
      expect(documentIds).toEqual(await idsInOrder());
    });

    it('selects only the id and the cursor column, not the whole row', async () => {
      await seed(5);

      const captured = recordQueries();
      await log.listDocumentIds({ collection: 'col-1' });
      const selects = captured.filter(
        (sql) => sql.includes('select') && sql.includes('rag_ingestion_log'),
      );

      expect(selects.length).toBeGreaterThan(0);
      for (const sql of selects) {
        expect(sql).toContain('document_id');
        expect(sql).toContain('updated_at');
        // the whole point of the projection: `error` is a TEXT column, and an orphan sweep that only
        // wants the id set has no business dragging every stack trace in the table into memory
        expect(sql).not.toContain('error');
        expect(sql).not.toContain('mime_type');
      }
    });

    it('filters the same way the sweep does', async () => {
      await seed(4, { collection: 'col-1' });
      await seed(3, { collection: 'col-2', prefix: 'other' });

      expect(await log.listDocumentIds({ collection: 'col-2' })).toEqual([
        'other-002',
        'other-001',
        'other-000',
      ]);
      expect(await log.listDocumentIds({ collection: 'col-1', status: 'skipped' })).toEqual([]);
    });
  });
});
