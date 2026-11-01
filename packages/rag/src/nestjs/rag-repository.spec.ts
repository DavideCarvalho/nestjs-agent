import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { MemoryVectorStore } from '../memory-vector-store.js';
import { RagScopeRequiredError } from '../rag-index.js';
import { RagModule, RagRepository } from './index.js';

class Project {
  id!: string;
}
class Doc {
  id!: number;
  project!: Project;
  owner?: string | null;
  body?: string;
}

@Injectable()
class DocumentsRag extends RagRepository<Doc> {
  protected readonly name = 'doc';
  readonly scope = { projectId: (d: Doc) => d.project.id };
  id(d: Doc) {
    return d.id;
  }
  protected text(d: Doc) {
    return d.body;
  }
}

// @ts-expect-error `scope` is abstract: leaving it out does not compile
class NoScope extends RagRepository<Doc> {
  protected readonly name = 'x';
  id(d: Doc) {
    return d.id;
  }
  protected text() {
    return '';
  }
}

class NullableScope extends RagRepository<Doc> {
  protected readonly name = 'x';
  // @ts-expect-error a nullable column cannot be a scope
  readonly scope = { owner: (d: Doc) => d.owner };
  id(d: Doc) {
    return d.id;
  }
  protected text() {
    return '';
  }
}

class RelationScope extends RagRepository<Doc> {
  protected readonly name = 'x';
  // @ts-expect-error a relation cannot be a scope
  readonly scope = { project: (d: Doc) => d.project };
  id(d: Doc) {
    return d.id;
  }
  protected text() {
    return '';
  }
}

class GlobalRag extends RagRepository<Doc> {
  protected readonly name = 'g';
  readonly scope = {};
  id(d: Doc) {
    return d.id;
  }
  protected text() {
    return '';
  }
}

@Injectable()
class Service {
  constructor(readonly rag: DocumentsRag) {}

  ask(projectId: string) {
    return this.rag.search('q', { scope: { projectId } });
  }

  typeContract(global: GlobalRag) {
    void global.search('q', {});
    // @ts-expect-error scope is required
    void this.rag.search('q', {});
    // @ts-expect-error wrong key
    void this.rag.search('q', { scope: { tenantId: 'a' } });
    // @ts-expect-error undefined
    void this.rag.search('q', { scope: { projectId: undefined } });
    // @ts-expect-error a bare array cannot widen
    void this.rag.search('q', { scope: { projectId: ['a'] } });
    // @ts-expect-error a filter cannot name a scope key
    void this.rag.search('q', { scope: { projectId: 'a' }, filter: { projectId: 'b' } });
  }
}

@Module({
  imports: [RagModule.forFeature([DocumentsRag])],
  providers: [Service],
  exports: [Service],
})
class FeatureModule {}

const embedder = { embed: async (t: string[]) => t.map(() => [1, 0]) };

async function boot(root: ReturnType<typeof RagModule.forRoot>) {
  const app = await Test.createTestingModule({ imports: [root, FeatureModule] }).compile();
  return app.get(Service);
}

describe('RagModule + RagRepository', () => {
  it('resolves by type, with no constructor in the subclass', async () => {
    const service = await boot(RagModule.forRoot({ store: new MemoryVectorStore(), embedder }));
    await service.rag.index({ id: 1, project: { id: 'a' }, body: 'x' });
    await service.rag.index({ id: 2, project: { id: 'b' }, body: 'y' });
    expect((await service.ask('a')).map((p) => p.id)).toEqual(['doc:1#0']);
  });

  it('enforces the scope at runtime', async () => {
    const service = await boot(RagModule.forRoot({ store: new MemoryVectorStore(), embedder }));
    await expect(service.rag.search('q', {} as never)).rejects.toBeInstanceOf(
      RagScopeRequiredError,
    );
  });

  it('forRootAsync resolves its deps through DI', async () => {
    const service = await boot(
      RagModule.forRootAsync({ useFactory: () => ({ store: new MemoryVectorStore(), embedder }) }),
    );
    expect(await service.rag.index({ id: 1, project: { id: 'a' }, body: 'x' })).toBe(1);
  });

  it('remove and reconcile work through the repository', async () => {
    const store = new MemoryVectorStore();
    const service = await boot(RagModule.forRoot({ store, embedder }));
    const doc = { id: 1, project: { id: 'a' }, body: 'x' };
    await service.rag.index(doc);
    await service.rag.index({ ...doc, id: 2 });
    await service.rag.remove(doc);
    expect((await service.rag.reconcile([])).orphans).toEqual(['doc:2']);
    expect(await store.countChunks()).toBe(0);
  });
});

void [NoScope, NullableScope, RelationScope];
