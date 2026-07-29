import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type { EmbeddingProvider } from '@dudousxd/nestjs-agent-core';
import { MemoryVectorStore } from '@dudousxd/nestjs-agent-rag';
import { FakeEmbeddingProvider } from '@dudousxd/nestjs-agent-testing';
import { channelName } from '@dudousxd/nestjs-diagnostics';
import { afterEach, describe, expect, it } from 'vitest';
import type { MediaAttachEvent, MediaDeleteEvent } from './media-events.js';
import { runMediaIngestJob } from './media-ingest-job.js';
import {
  type MediaIngestionDeps,
  ingestMediaFile,
  mediaIngestFailureKind,
} from './media-ingestion.js';
import { MimeTextExtractor, UnsupportedMimeTypeError } from './text-extractor.js';

const EVENT: MediaAttachEvent = {
  id: 'doc-1',
  ownerType: 'user',
  ownerId: 'u1',
  collection: 'knowledge-base',
  disk: 'docs',
  path: 'notes.txt',
  size: 11,
  mimeType: 'text/plain',
};

const DELETE_EVENT: MediaDeleteEvent = { id: 'doc-1', ownerType: 'user', ownerId: 'u1' };

/** A named error class, so the assertions can prove the ORIGINAL object came through unwrapped. */
class Boom extends Error {
  constructor(
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'Boom';
  }
}

const listeners: { channel: string; fn: (message: unknown) => void }[] = [];

function capture(event: string): Record<string, unknown>[] {
  const seen: Record<string, unknown>[] = [];
  const channel = channelName('rag', event);
  const fn = (message: unknown) => {
    const payload = (message as { payload?: Record<string, unknown> })?.payload;
    if (payload) seen.push(payload);
  };
  subscribe(channel, fn);
  listeners.push({ channel, fn });
  return seen;
}

function deps(extra?: Partial<MediaIngestionDeps>): MediaIngestionDeps {
  return {
    store: new MemoryVectorStore(),
    embedder: new FakeEmbeddingProvider(),
    readFile: async () => Buffer.from('hello world'),
    ...extra,
  };
}

/** Run an ingest job to its failed outcome. Fails the test loudly if it somehow succeeded. */
async function failWith(extra: Partial<MediaIngestionDeps>) {
  const outcome = await runMediaIngestJob({ type: 'ingest', event: EVENT }, deps(extra));
  if (outcome.status !== 'failed') {
    throw new Error(`expected a failed outcome, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

afterEach(() => {
  for (const { channel, fn } of listeners.splice(0)) {
    unsubscribe(channel, fn);
  }
});

describe('failure kind per phase', () => {
  it('tags a statFile throw as read — the probe is storage-side too', async () => {
    const outcome = await failWith({
      statFile: async () => {
        throw new Boom('HeadObject 503');
      },
    });

    expect(outcome.kind).toBe('read');
    expect(outcome.error).toBe('HeadObject 503');
  });

  it('tags a readFile throw as read', async () => {
    const outcome = await failWith({
      readFile: async () => {
        throw new Boom('S3 connection reset');
      },
    });

    expect(outcome.kind).toBe('read');
  });

  it('tags an extractor throw as extract', async () => {
    const outcome = await failWith({
      extractor: {
        extract: async () => {
          throw new Boom('corrupt PDF: xref table not found');
        },
      },
    });

    expect(outcome.kind).toBe('extract');
  });

  it('tags a host metadata throw as extract — it is evaluated while building the chunks', async () => {
    const outcome = await failWith({
      metadata: () => {
        throw new Boom('no capability tokens for this collection');
      },
    });

    expect(outcome.kind).toBe('extract');
  });

  it('tags an embedder throw as embed, not store', async () => {
    const embedder: EmbeddingProvider = {
      embed: async () => {
        throw new Boom('Bedrock throttled', 30);
      },
    };
    const outcome = await failWith({ embedder });

    expect(outcome.kind).toBe('embed');
  });

  it('tags the pre-ingest store.remove as store', async () => {
    const store = new MemoryVectorStore();
    store.remove = async () => {
      throw new Boom('index unavailable');
    };
    const outcome = await failWith({ store });

    expect(outcome.kind).toBe('store');
  });

  it('tags the final upsert as store — the other half of the same ingestChunks call', async () => {
    const store = new MemoryVectorStore();
    store.upsert = async () => {
      throw new Boom('vector dimension mismatch');
    };
    const outcome = await failWith({ store });

    expect(outcome.kind).toBe('store');
  });

  it('splits embed from store even though one ingestChunks call does both', async () => {
    // The subtle one: `ingestChunks(chunks, { embedder, store })` embeds AND upserts behind a single
    // call, so a single wrapper would have to label both the same. Same call site, two deps made to
    // fail, two different kinds — proving the inner delegate wins and the outer wrapper covers the
    // rest by elimination.
    const embedFails = new MemoryVectorStore();
    const upsertFails = new MemoryVectorStore();
    upsertFails.upsert = async () => {
      throw new Boom('upsert rejected');
    };

    const embedOutcome = await failWith({
      store: embedFails,
      embedder: {
        embed: async () => {
          throw new Boom('embed rejected');
        },
      },
    });
    const storeOutcome = await failWith({ store: upsertFails });

    expect([embedOutcome.kind, storeOutcome.kind]).toEqual(['embed', 'store']);
  });

  it('tags a delete-sync store failure as store', async () => {
    const store = new MemoryVectorStore();
    store.remove = async () => {
      throw new Boom('index unavailable');
    };
    const outcome = await runMediaIngestJob(
      { type: 'remove', event: DELETE_EVENT },
      deps({ store }),
    );

    expect(outcome).toMatchObject({ status: 'failed', error: 'index unavailable', kind: 'store' });
  });
});

describe('what the failed outcome carries', () => {
  it('keeps error exactly as it was, and hands back the original error object as cause', async () => {
    const thrown = new Boom('Bedrock throttled', 30);
    const outcome = await failWith({ embedder: { embed: async () => Promise.reject(thrown) } });

    expect(outcome.error).toBe('Bedrock throttled');
    // the whole point: a host can apply ITS retry policy off the real error, not a parsed string
    expect(outcome.cause).toBe(thrown);
    expect(outcome.cause).toBeInstanceOf(Boom);
    expect((outcome.cause as Boom).retryAfter).toBe(30);
  });

  it("preserves a thrown error's own cause chain", async () => {
    const root = new Error('ECONNRESET');
    const thrown = new Boom('read failed');
    thrown.cause = root;
    const outcome = await failWith({ readFile: async () => Promise.reject(thrown) });

    expect((outcome.cause as Error).cause).toBe(root);
  });

  it('falls back to unknown for a non-object throw, rather than leaving kind undefined', async () => {
    const outcome = await failWith({
      // deliberately not an Error — nothing to hang a property off
      readFile: async () => {
        throw 'just a string';
      },
    });

    expect(outcome.kind).toBe('unknown');
    expect(outcome.error).toBe('just a string');
  });

  it('never reports a kind for a success or a skip — the field is on the failed arm only', async () => {
    const ingested = await runMediaIngestJob({ type: 'ingest', event: EVENT }, deps());
    const skipped = await runMediaIngestJob(
      { type: 'ingest', event: EVENT },
      deps({ maxBytes: 1 }),
    );

    expect(ingested).toEqual({ status: 'ingested', chunks: 1 });
    expect(skipped).toEqual({ status: 'skipped', reason: 'too-large' });
  });
});

describe('the media.failed diagnostic', () => {
  it('carries the phase as a plain string, and does NOT carry the cause', async () => {
    const failed = capture('media.failed');
    await failWith({
      extractor: {
        extract: async () => {
          throw new Boom('corrupt PDF');
        },
      },
    });

    expect(failed[0]).toMatchObject({
      mediaId: 'doc-1',
      collection: 'knowledge-base',
      error: 'corrupt PDF',
      kind: 'extract',
    });
    // `cause` is in-process only. Telescope and the ingestion log clone/persist this payload, and an
    // Error JSON-stringifies to `{}` — so it must not be here at all.
    expect(failed[0]).not.toHaveProperty('cause');
    expect(JSON.parse(JSON.stringify(failed[0]))).toMatchObject({ kind: 'extract' });
  });
});

describe('mediaIngestFailureKind, for callers that catch the throw', () => {
  it('reads the phase off an error that escaped ingestMediaFile directly', async () => {
    const thrown = new Boom('S3 connection reset');
    await expect(
      ingestMediaFile(EVENT, deps({ readFile: async () => Promise.reject(thrown) })),
    ).rejects.toBe(thrown);

    expect(mediaIngestFailureKind(thrown)).toBe('read');
  });

  it('returns unknown for anything it never tagged', () => {
    expect(mediaIngestFailureKind(new Error('unrelated'))).toBe('unknown');
    expect(mediaIngestFailureKind(undefined)).toBe('unknown');
    expect(mediaIngestFailureKind(null)).toBe('unknown');
    expect(mediaIngestFailureKind('nope')).toBe('unknown');
    // a forged value of the wrong shape is not trusted
    expect(
      mediaIngestFailureKind({ [Symbol.for('aviary.rag.media.ingestFailureKind')]: 'nonsense' }),
    ).toBe('unknown');
  });

  it('reads a tag written by a SEPARATE copy of the symbol — the registered-symbol guarantee', () => {
    // Simulates a duplicated package instance: a module-local `Symbol()` would not be equal here,
    // and the kind would silently read `unknown`.
    const error = new Error('from another copy of the package');
    Object.defineProperty(error, Symbol.for('aviary.rag.media.ingestFailureKind'), {
      value: 'embed',
      enumerable: false,
    });

    expect(mediaIngestFailureKind(error)).toBe('embed');
  });
});

describe('tagging is non-destructive', () => {
  it('re-throws the SAME error object, so an instanceof check in a direct caller still works', async () => {
    const thrown = new Boom('S3 connection reset');
    let caught: unknown;
    try {
      await ingestMediaFile(EVENT, deps({ readFile: async () => Promise.reject(thrown) }));
    } catch (error) {
      caught = error;
    }

    // identity, not just shape: wrapping in a MediaIngestError would break every existing
    // `catch (e) { if (e instanceof S3Error) … }`.
    expect(caught).toBe(thrown);
    expect(caught).toBeInstanceOf(Boom);
  });

  it('cannot leak into a JSON log or an object spread', async () => {
    const tag = Symbol.for('aviary.rag.media.ingestFailureKind');
    const thrown = new Boom('S3 connection reset');
    const keysBefore = Object.keys(thrown);
    const jsonBefore = JSON.stringify({ ...thrown });
    await failWith({ readFile: async () => Promise.reject(thrown) });

    // it IS tagged...
    expect(mediaIngestFailureKind(thrown)).toBe('read');
    // ...and the tag is invisible to every serialization path a log or Telescope would take
    expect(Object.propertyIsEnumerable.call(thrown, tag)).toBe(false);
    expect(Object.keys(thrown)).toEqual(keysBefore);
    expect(JSON.stringify({ ...thrown })).toBe(jsonBefore);
    expect(JSON.stringify(thrown)).toBe(jsonBefore);
    expect(Object.keys(structuredClone({ ...thrown }))).toEqual(keysBefore);
  });

  it('survives a frozen error instead of replacing it with a TypeError', async () => {
    const thrown = Object.freeze(new Boom('immutable failure'));
    const outcome = await failWith({ readFile: async () => Promise.reject(thrown) });

    // the tag is lost (nothing can be written), but the REAL failure is still the one reported
    expect(outcome.error).toBe('immutable failure');
    expect(outcome.cause).toBe(thrown);
    expect(outcome.kind).toBe('unknown');
  });

  it('lets the innermost phase win rather than the outermost wrapper', async () => {
    // The embedder is called from inside the `store`-tagged wrapper around `ingestChunks`. If the
    // outer tag overwrote the inner one, this would read 'store'.
    const outcome = await failWith({
      embedder: {
        embed: async () => {
          throw new Boom('embed rejected');
        },
      },
    });

    expect(outcome.kind).toBe('embed');
  });
});

describe('the unsupported-type skip path is untouched', () => {
  it('still skips rather than failing, even though extract is now a tagged phase', async () => {
    const skipped = capture('media.skipped');
    const failed = capture('media.failed');
    const outcome = await runMediaIngestJob(
      { type: 'ingest', event: EVENT },
      // an extractor that knows only PDFs, fed a text/plain event
      deps({ extractor: new MimeTextExtractor() }),
    );

    expect(outcome).toEqual({ status: 'skipped', reason: 'unsupported-type' });
    expect(skipped[0]).toMatchObject({ reason: 'unsupported-type' });
    expect(failed).toHaveLength(0);
  });

  it('skips an UnsupportedMimeTypeError thrown by a custom extractor too', async () => {
    const outcome = await runMediaIngestJob(
      { type: 'ingest', event: EVENT },
      deps({
        extractor: {
          extract: async () => {
            throw new UnsupportedMimeTypeError('application/octet-stream');
          },
        },
      }),
    );

    expect(outcome).toEqual({ status: 'skipped', reason: 'unsupported-type' });
  });
});
