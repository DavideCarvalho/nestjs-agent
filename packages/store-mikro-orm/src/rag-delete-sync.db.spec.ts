// Concurrent transactions need more than SQLite's single connection, so this runs on Postgres.
import { EntitySchema } from '@mikro-orm/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RagDeleteSubscriber } from './rag-delete-sync';
import { createScratchDatabase, openOrmAt, rawSql, unavailable } from './testing/real-db';

class Doc {
  id!: number;
}
const DocSchema = new EntitySchema({
  class: Doc,
  tableName: 'sync_doc',
  properties: { id: { type: 'number', primary: true } },
});

describe.skipIf(unavailable('postgres') !== undefined)('RagDeleteSubscriber on Postgres', () => {
  let drop: () => Promise<void>;
  let orm: Awaited<ReturnType<typeof openOrmAt>>;
  const removed: (string | number)[] = [];

  beforeAll(async () => {
    const database = await createScratchDatabase('postgres');
    drop = database.drop;
    orm = await openOrmAt('postgres', database.url, [DocSchema]);
    await rawSql(orm, 'create table sync_doc (id int primary key)');
    await rawSql(orm, 'insert into sync_doc values (1), (2)');
    orm.em.getEventManager().registerSubscriber(
      new RagDeleteSubscriber<Doc>(Doc, {
        id: (doc) => doc.id,
        remove: async (id) => {
          removed.push(id);
        },
      }),
    );
  });
  afterAll(async () => {
    await orm.close();
    await drop();
  });

  it('overlapping transactions keep their ids apart', async () => {
    let release: () => void = () => undefined;
    const bothFlushed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let flushed = 0;
    const flushedOne = () => {
      flushed += 1;
      if (flushed === 2) release();
    };
    const rolledBack = orm.em
      .fork()
      .transactional(async (tx) => {
        tx.remove(tx.getReference(Doc, 1));
        await tx.flush();
        flushedOne();
        await bothFlushed;
        throw new Error('rollback');
      })
      .catch(() => undefined);
    const committed = orm.em.fork().transactional(async (tx) => {
      tx.remove(tx.getReference(Doc, 2));
      await tx.flush();
      flushedOne();
      await bothFlushed;
    });
    await Promise.all([rolledBack, committed]);
    expect(removed).toEqual([2]);
    expect(await orm.em.fork().count(Doc)).toBe(1);
  });
});
