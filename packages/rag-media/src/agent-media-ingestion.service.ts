import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { channelName } from '@dudousxd/nestjs-diagnostics';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { publishRagMediaFailed } from './diagnostics.js';
import {
  type MediaAttachEvent,
  type MediaConversionEvent,
  envelopePayload,
  isMediaAttachEvent,
  isMediaConversionEvent,
  isMediaDeleteEvent,
} from './media-events.js';
import { type MediaIngestJob, applyMediaIngestJob } from './media-ingest-job.js';
import type { MediaIngestionDeps } from './media-ingestion.js';

/**
 * Ingest server-side conversions (PDF→text, OCR, …) instead of extracting from the original bytes —
 * offloading heavy extraction to the media library's own pipeline. Bundled so `names` and `resolve`
 * are co-required (you can't declare one without the other).
 */
export interface MediaConversionIngestion {
  /** Conversion names to ingest (e.g. `['text']`); other conversions are ignored. */
  names: string[];
  /**
   * Resolve a conversion event to an ingestable descriptor — owner/collection/disk from the media
   * record plus the converted artifact's `path`/`mimeType`. Reuse the media record's `id` so the
   * derived text shares the original's document id (delete-sync then covers both). Return `null` to
   * skip.
   */
  resolve: (
    event: MediaConversionEvent,
  ) => MediaAttachEvent | null | Promise<MediaAttachEvent | null>;
}

export interface AgentMediaIngestionOptions extends MediaIngestionDeps {
  /** Restrict ingestion to these media collections. Omit/empty = every collection. */
  collections?: string[];
  /** Also ingest matching server-side conversions (PDF→text, OCR, …). See {@link MediaConversionIngestion}. */
  conversions?: MediaConversionIngestion;
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
  private readonly conversions: {
    names: Set<string>;
    resolve: MediaConversionIngestion['resolve'];
  } | null;
  private readonly config: MediaIngestionDeps;
  private readonly enqueue: ((job: MediaIngestJob) => void | Promise<void>) | undefined;
  private readonly inFlight = new Set<Promise<void>>();
  private teardowns: (() => void)[] = [];

  constructor(options: AgentMediaIngestionOptions) {
    this.collections =
      options.collections !== undefined && options.collections.length > 0
        ? new Set(options.collections)
        : null;
    this.conversions =
      options.conversions !== undefined
        ? { names: new Set(options.conversions.names), resolve: options.conversions.resolve }
        : null;
    // options *is* a MediaIngestionDeps (+ collections/conversions/enqueue) — pass it straight
    // through; the pure functions default the extractor. No separate "resolved deps" to keep in sync.
    this.config = options;
    this.enqueue = options.enqueue;
  }

  onModuleInit(): void {
    this.listen(channelName('media', 'attach'), (payload) => this.handleAttach(payload));
    this.listen(channelName('media', 'delete'), (payload) => this.handleDelete(payload));
    if (this.conversions !== null) {
      this.listen(channelName('media', 'conversion'), (payload) => this.handleConversion(payload));
    }
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

  /** Guard + ingest one attach. Public so a caller can await it directly. */
  async handleAttach(payload: unknown): Promise<void> {
    if (isMediaAttachEvent(payload)) {
      await this.ingestAttach(payload);
    }
  }

  /** Guard + dispatch a delete. Public so a caller can await it directly. */
  async handleDelete(payload: unknown): Promise<void> {
    if (!isMediaDeleteEvent(payload)) {
      return;
    }
    await this.dispatch({ type: 'remove', event: payload });
  }

  /**
   * Guard + resolve + ingest a finished conversion (PDF→text, OCR, …). The derived artifact is
   * ingested under the media record's id — the same document as the original — so delete-sync covers
   * it and a skipped original (unsupported binary) never wipes it. Public so a caller can await it.
   */
  async handleConversion(payload: unknown): Promise<void> {
    if (this.conversions === null || !isMediaConversionEvent(payload)) {
      return;
    }
    if (!this.conversions.names.has(payload.conversion)) {
      return;
    }
    const event = await this.conversions.resolve(payload);
    if (event !== null) {
      await this.ingestAttach(event);
    }
  }

  /** Collection-filter + dispatch an ingest — shared by attach and conversion. */
  private async ingestAttach(event: MediaAttachEvent): Promise<void> {
    if (this.collections !== null && !this.collections.has(event.collection)) {
      return;
    }
    await this.dispatch({ type: 'ingest', event });
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
        await applyMediaIngestJob(job, this.config);
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
