import { EntityManager, EntitySchema } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/sqlite';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RagDeleteSubscriber, provideRagDeleteSync } from './rag-delete-sync';

class Doc {
  id!: number;
  title?: string;
}
class Other {
  id!: number;
}
const DocSchema = new EntitySchema({
  class: Doc,
  tableName: 'sync_doc',
  properties: { id: { type: 'number', primary: true }, title: { type: 'string', nullable: true } },
});
const OtherSchema = new EntitySchema({
  class: Other,
  tableName: 'sync_other',
  properties: { id: { type: 'number', primary: true } },
});

describe('RagDeleteSubscriber', () => {
  let orm: MikroORM;
  const removed: (string | number)[] = [];
  let failing = false;

  beforeAll(async () => {
    orm = await MikroORM.init({ dbName: ':memory:', entities: [DocSchema, OtherSchema] });
    await orm.schema.create();
    orm.em.getEventManager().registerSubscriber(
      new RagDeleteSubscriber<Doc>(Doc, {
        id: (doc) => doc.id,
        remove: async (id) => {
          if (failing) throw new Error('store down');
          removed.push(id);
        },
      }),
    );
  });
  afterAll(() => orm.close());

  beforeEach(async () => {
    removed.length = 0;
    failing = false;
    const em = orm.em.fork();
    await em.nativeDelete(Doc, {});
    await em.nativeDelete(Other, {});
    for (const id of [1, 2, 3]) em.create(Doc, { id });
    em.create(Other, { id: 1 });
    await em.flush();
  });

  it('removes after a flush commits, with the id captured before the delete', async () => {
    const em = orm.em.fork();
    em.remove(em.getReference(Doc, 1));
    await em.flush();
    expect(removed).toEqual([1]);
  });

  it('removes after an explicit transaction commits', async () => {
    await orm.em.fork().transactional(async (tx) => {
      tx.remove(tx.getReference(Doc, 1));
      await tx.flush();
      expect(removed).toEqual([]);
      tx.remove(tx.getReference(Doc, 2));
      await tx.flush();
    });
    expect(removed.sort()).toEqual([1, 2]);
  });

  it('removes nothing on a rollback', async () => {
    await orm.em
      .fork()
      .transactional(async (tx) => {
        tx.remove(tx.getReference(Doc, 1));
        await tx.flush();
        throw new Error('rollback');
      })
      .catch(() => undefined);
    expect(removed).toEqual([]);
    expect(await orm.em.fork().count(Doc)).toBe(3);
  });

  it('a nested transaction waits for the outer commit', async () => {
    await orm.em
      .fork()
      .transactional(async (tx) => {
        await tx.transactional(async (inner) => {
          inner.remove(inner.getReference(Doc, 1));
          await inner.flush();
        });
        throw new Error('outer rollback');
      })
      .catch(() => undefined);
    expect(removed).toEqual([]);
    expect(await orm.em.fork().count(Doc)).toBe(3);
  });

  it('an inner commit waits, and an outer commit removes', async () => {
    await orm.em.fork().transactional(async (tx) => {
      await tx.transactional(async (inner) => {
        inner.remove(inner.getReference(Doc, 1));
        await inner.flush();
      });
      expect(removed).toEqual([]);
    });
    expect(removed).toEqual([1]);
  });

  it('a rolled-back savepoint drops only its own ids', async () => {
    await orm.em.fork().transactional(async (tx) => {
      tx.remove(tx.getReference(Doc, 2));
      await tx.flush();
      await tx
        .transactional(async (inner) => {
          inner.remove(inner.getReference(Doc, 1));
          await inner.flush();
          throw new Error('inner rollback');
        })
        .catch(() => undefined);
    });
    expect(removed).toEqual([2]);
    expect(await orm.em.fork().count(Doc)).toBe(2);
  });

  it('provideRagDeleteSync registers through Nest DI', async () => {
    const seen: (string | number)[] = [];
    class Repository {
      id(doc: Doc) {
        return doc.id;
      }
      async remove(id: string | number) {
        seen.push(id);
      }
    }
    const moduleOrm = await MikroORM.init({
      dbName: ':memory:',
      entities: [DocSchema, OtherSchema],
    });
    await moduleOrm.schema.create();
    const app = await Test.createTestingModule({
      providers: [
        { provide: EntityManager, useValue: moduleOrm.em },
        Repository,
        provideRagDeleteSync(Doc, Repository),
      ],
    }).compile();
    await app.init();
    const em = moduleOrm.em.fork();
    em.create(Doc, { id: 9 });
    await em.flush();
    em.remove(em.getReference(Doc, 9));
    await em.flush();
    expect(seen).toEqual([9]);
    await moduleOrm.close();
  });

  it('ignores other entities', async () => {
    const em = orm.em.fork();
    em.remove(em.getReference(Other, 1));
    await em.flush();
    expect(removed).toEqual([]);
  });

  it('nativeDelete fires nothing, as documented', async () => {
    await orm.em.fork().nativeDelete(Doc, { id: 3 });
    expect(removed).toEqual([]);
  });

  it('a failing removal does not fail the flush', async () => {
    failing = true;
    const em = orm.em.fork();
    em.remove(em.getReference(Doc, 1));
    await expect(em.flush()).resolves.toBeUndefined();
    expect(await orm.em.fork().count(Doc)).toBe(2);
  });
});
