import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type { EmbeddingProvider } from '@dudousxd/nestjs-agent-core';
import type { ChunkOptions, VectorStore } from '@dudousxd/nestjs-agent-rag';
import { channelName } from '@dudousxd/nestjs-diagnostics';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { publishRagMediaFailed } from './diagnostics.js';
import { envelopePayload, isMediaAttachEvent, isMediaDeleteEvent } from './media-events.js';
import { type MediaIngestJob, applyMediaIngestJob } from './media-ingest-job.js';
import type { MediaIngestionDeps, ReadFile } from './media-ingestion.js';
import { type TextExtractor, defaultTextExtractor } from './text-extractor.js';

export interface AgentMediaIngestionOptions {
  /** Read a media file's bytes. Wire `(disk, path) => media.disk(disk).get(path)` — no media import. */
  readFile: ReadFile;
  embedder: EmbeddingProvider;
  store: VectorStore;
  /** Restrict ingestion to these media collections. Omit/empty = every collection. */
  collections?: string[];
  /** Bytes → text. Default {@link defaultTextExtractor} (text/*, JSON, HTML). */
  extractor?: TextExtractor;
  chunk?: ChunkOptions;
  maxBytes?: number;
  /**
   * Opt-in at-least-once. When set, attach/delete are handed to this queue instead of ingested
   * inline — wire it to a durable workflow that calls `applyMediaIngestJob(job, deps)`. Default:
   * inline ingestion.
   */
  enqueue?: (job: MediaIngestJob) => void | Promise<void>;
}

/**
 * Bridges `@dudousxd/nestjs-media` uploads into agent RAG. On init it subscribes to the
 * `aviary:media:attach` / `aviary:media:delete` diagnostics channels (the same seam Telescope rides,
 * so there's no dependency on the media package) and ingests / removes each file. It couples only to
 * the channel contract; the host supplies `readFile` to reach the actual bytes.
 */
@Injectable()
export class AgentMediaIngestionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentMediaIngestionService.name);
  private readonly collections: Set<string> | null;
  private readonly deps: MediaIngestionDeps;
  private readonly enqueue: ((job: MediaIngestJob) => void | Promise<void>) | undefined;
  private readonly inFlight = new Set<Promise<void>>();
  private teardowns: (() => void)[] = [];

  constructor(options: AgentMediaIngestionOptions) {
    this.collections =
      options.collections !== undefined && options.collections.length > 0
        ? new Set(options.collections)
        : null;
    this.deps = {
      readFile: options.readFile,
      embedder: options.embedder,
      store: options.store,
      extractor: options.extractor ?? defaultTextExtractor(),
      ...(options.chunk !== undefined ? { chunk: options.chunk } : {}),
      ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    };
    this.enqueue = options.enqueue;
  }

  onModuleInit(): void {
    this.listen(channelName('media', 'attach'), (payload) => this.handleAttach(payload));
    this.listen(channelName('media', 'delete'), (payload) => this.handleDelete(payload));
  }

  async onModuleDestroy(): Promise<void> {
    for (const teardown of this.teardowns) {
      teardown();
    }
    this.teardowns = [];
    await this.settle();
  }

  /** Await every in-flight ingestion — for graceful shutdown and deterministic tests. */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  /** Guard + collection-filter + dispatch one attach. Public so a caller can await it directly. */
  async handleAttach(payload: unknown): Promise<void> {
    if (!isMediaAttachEvent(payload)) {
      return;
    }
    if (this.collections !== null && !this.collections.has(payload.collection)) {
      return;
    }
    await this.dispatch({ type: 'ingest', event: payload });
  }

  /** Guard + dispatch a delete. Public so a caller can await it directly. */
  async handleDelete(payload: unknown): Promise<void> {
    if (!isMediaDeleteEvent(payload)) {
      return;
    }
    await this.dispatch({ type: 'remove', event: payload });
  }

  /**
   * Route one job to the durable queue (when `enqueue` is set) or run it inline — a single error
   * boundary, and the inline path is the very same `applyMediaIngestJob` a durable worker replays,
   * so the two can't drift.
   */
  private async dispatch(job: MediaIngestJob): Promise<void> {
    try {
      if (this.enqueue !== undefined) {
        await this.enqueue(job);
      } else {
        await applyMediaIngestJob(job, this.deps);
      }
    } catch (error) {
      const action = job.type === 'ingest' ? 'ingestion' : 'delete-sync';
      const message = errorMessage(error);
      this.logger.error(`RAG ${action} failed for media ${job.event.id}: ${message}`);
      publishRagMediaFailed({ mediaId: job.event.id, error: message });
    }
  }

  private listen(name: string, handler: (payload: unknown) => Promise<void>): void {
    const listener = (message: unknown): void => {
      this.track(handler(envelopePayload(message)));
    };
    subscribe(name, listener);
    this.teardowns.push(() => unsubscribe(name, listener));
  }

  private track(promise: Promise<void>): void {
    const tracked = promise.finally(() => {
      this.inFlight.delete(tracked);
    });
    this.inFlight.add(tracked);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
