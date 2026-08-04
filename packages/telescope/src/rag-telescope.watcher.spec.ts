import { emit, isDiagnosticClaimed } from '@dudousxd/nestjs-diagnostics';
import type { RecordInput } from '@dudousxd/nestjs-telescope';
import { afterEach, describe, expect, it } from 'vitest';
import { RagTelescopeWatcher } from './rag-telescope.watcher.js';

/**
 * The watcher narrowed to what these tests drive. `register` only ever touches `ctx.record`, and a
 * method's parameters are compared bivariantly, so a real `RagTelescopeWatcher` assigns to this
 * without a cast — which is what lets the spec hand it a two-line context instead of faking a
 * `ModuleRef` and a resolved core config it never reads.
 */
interface WatcherUnderTest {
  readonly type: string;
  register(ctx: { record(input: RecordInput): void }): void;
  dispose(): void;
}

let watcher: WatcherUnderTest | undefined;

afterEach(() => {
  watcher?.dispose();
  watcher = undefined;
});

function register(): RecordInput[] {
  const recorded: RecordInput[] = [];
  watcher = new RagTelescopeWatcher();
  watcher.register({ record: (input) => recorded.push(input) });
  return recorded;
}

describe('RagTelescopeWatcher', () => {
  it('declares its own entry type, separate from `agent`', () => {
    expect(new RagTelescopeWatcher().type).toBe('agent-rag');
  });

  it('records an aviary:rag:retrieval event, lifting the envelope duration into the content', () => {
    const recorded = register();

    emit(
      'rag',
      'retrieval',
      {
        retriever: 'hybrid',
        store: 'redis',
        collection: 'kb_idx',
        topK: 5,
        chunks: 0,
        zeroHit: true,
        failed: false,
      },
      { durationMs: 73 },
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.type).toBe('agent-rag');
    expect(recorded[0]?.content).toMatchObject({
      event: 'retrieval',
      retriever: 'hybrid',
      store: 'redis',
      collection: 'kb_idx',
      chunks: 0,
      zeroHit: true,
      durationMs: 73,
    });
    expect(recorded[0]?.tags).toEqual(['retrieval', 'retriever:hybrid', 'store:redis', 'zero-hit']);
  });

  it('tags a failed retrieval so the Entries screen can filter to it', () => {
    const recorded = register();

    emit(
      'rag',
      'retrieval',
      { retriever: 'embedding', chunks: 0, zeroHit: true, failed: true },
      {},
    );

    expect(recorded[0]?.tags).toContain('failed');
  });

  it('claims rag:retrieval so the generic diagnostics bridge does not record it twice', () => {
    register();
    expect(isDiagnosticClaimed('rag', 'retrieval')).toBe(true);

    watcher?.dispose();
    watcher = undefined;
    expect(isDiagnosticClaimed('rag', 'retrieval')).toBe(false);
  });

  it('stops recording once disposed', () => {
    const recorded = register();
    watcher?.dispose();
    watcher = undefined;

    emit('rag', 'retrieval', { retriever: 'embedding', chunks: 1 }, { durationMs: 1 });

    expect(recorded).toEqual([]);
  });
});
