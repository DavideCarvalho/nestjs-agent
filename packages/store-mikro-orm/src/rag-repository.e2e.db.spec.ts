// RagRepository, Nest DI, MikroORM and pgvector together, on a real Postgres with the extension.
import { PgVectorStore, RagScopeRequiredError } from '@dudousxd/nestjs-agent-rag';
import { RagModule, RagRepository } from '@dudousxd/nestjs-agent-rag/nestjs';
import { EntityManager, EntitySchema } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { provideRagDeleteSync } from './rag-delete-sync';

class Project {
  id!: number;
}
class Doc {
  id!: number;
  project!: Project;
  body?: string;
}
const ProjectSchema = new EntitySchema({
  class: Project,
  tableName: 'e2e_project',
  properties: { id: { type: 'number', primary: true } },
});
const DocSchema = new EntitySchema({
  class: Doc,
  tableName: 'e2e_doc',
  properties: {
    id: { type: 'number', primary: true },
    project: { kind: 'm:1', entity: () => Project },
    body: { type: 'string', nullable: true },
  },
});

@Injectable()
class DocumentsRag extends RagRepository<Doc> {
  protected readonly name = 'e2e_doc';
  readonly scope = { projectId: (d: Doc) => d.project.id };
  id(d: Doc) {
    return d.id;
  }
  protected text(d: Doc) {
    return d.body;
  }
}

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let orm: MikroORM;
let rag: DocumentsRag;
let store: PgVectorStore;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  const url = container.getConnectionUri();
  pool = new pg.Pool({ connectionString: url });
  await pool.query(
    'create table e2e_project (id int primary key); create table e2e_doc (id int primary key, project_id int not null references e2e_project(id) on delete cascade, body text)',
  );
  store = new PgVectorStore(pool, { table: 'e2e_chunks', dimensions: 2 });
  await store.ensureSchema();
  orm = await MikroORM.init({
    clientUrl: url,
    entities: [ProjectSchema, DocSchema],
    allowGlobalContext: true,
  });
  const app = await Test.createTestingModule({
    imports: [RagModule.forRoot({ store, embedder: { embed: async (t) => t.map(() => [1, 0]) } })],
    providers: [
      { provide: EntityManager, useValue: orm.em },
      DocumentsRag,
      provideRagDeleteSync(Doc, DocumentsRag),
    ],
  }).compile();
  rag = app.get(DocumentsRag);
}, 180_000);

afterAll(async () => {
  await orm?.close();
  await pool?.end();
  await container?.stop();
});

it('indexes, isolates, syncs a delete and reconciles a cascade', async () => {
  const em = orm.em.fork();
  const one = em.create(Project, { id: 1 });
  const two = em.create(Project, { id: 2 });
  const a = em.create(Doc, { id: 1, project: one, body: 'alpha' });
  const b = em.create(Doc, { id: 2, project: two, body: 'beta' });
  const c = em.create(Doc, { id: 3, project: two, body: 'gamma' });
  await em.flush();
  for (const doc of [a, b, c]) await rag.index(doc);

  const hits = await rag.search('q', { scope: { projectId: 1 } });
  expect(hits.map((hit) => hit.text)).toEqual(['alpha']);
  await expect(rag.search('q', {} as never)).rejects.toBeInstanceOf(RagScopeRequiredError);

  em.remove(a);
  await em.flush();
  expect(await store.listChunks('e2e_doc:1')).toEqual([]);

  await pool.query('delete from e2e_project where id = 2');
  const live = (await orm.em.fork().find(Doc, {})).map((doc) => doc.id);
  expect((await rag.reconcile(live)).orphans.sort()).toEqual(['e2e_doc:2', 'e2e_doc:3']);
  expect(await store.countChunks()).toBe(0);
});
