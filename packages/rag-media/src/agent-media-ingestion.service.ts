import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type { EmbeddingProvider } from '@dudousxd/nestjs-agent-core';
import type { ChunkOptions, VectorStore } from '@dudousxd/nestjs-agent-rag';
import { channelName } from '@dudousxd/nestjs-diagnostics';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { publishRagMediaFailed } from './diagnostics.js';
import { envelopePayload, isMediaAttachEvent, isMediaDeleteEvent } from './media-events.js';
import {
  type MediaIngestionDeps,
  type ReadFile,
  ingestMediaFile,
  removeMedia,
} from './media-ingestion.js';
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

  /** Guard + collection-filter + ingest one attach. Public so a caller can await it directly. */
  async handleAttach(payload: unknown): Promise<void> {
    if (!isMediaAttachEvent(payload)) {
      return;
    }
    if (this.collections !== null && !this.collections.has(payload.collection)) {
      return;
    }
    try {
      await ingestMediaFile(payload, this.deps);
    } catch (error) {
      const message = errorMessage(error);
      this.logger.error(`RAG ingestion failed for media ${payload.id}: ${message}`);
      publishRagMediaFailed({ mediaId: payload.id, error: message });
    }
  }

  /** Guard + drop a deleted media's chunks. Public so a caller can await it directly. */
  async handleDelete(payload: unknown): Promise<void> {
    if (!isMediaDeleteEvent(payload)) {
      return;
    }
    try {
      await removeMedia(payload, { store: this.deps.store });
    } catch (error) {
      const message = errorMessage(error);
      this.logger.error(`RAG delete-sync failed for media ${payload.id}: ${message}`);
      publishRagMediaFailed({ mediaId: payload.id, error: message });
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
