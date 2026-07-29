import { emit } from '@dudousxd/nestjs-diagnostics';
import type { MediaAttachEvent, MediaDeleteEvent } from './media-events.js';
// type-only, so the media-ingestion.ts ↔ diagnostics.ts edge is erased at compile time and no
// runtime import cycle exists.
import type { MediaIngestFailureKind } from './media-ingestion.js';

/**
 * Diagnostics this package publishes on `aviary:rag:*`, so ingestion is observable (Telescope's
 * generic bridge captures them) without instrumenting your code. `emit` is free when nobody listens.
 */
export interface RagMediaIngestedPayload {
  mediaId: string;
  ownerType: string;
  ownerId: string;
  collection: string;
  /** Citation-facing origin (the media record's `path`). */
  source: string;
  size: number;
  mimeType: string;
  chunks: number;
}
export interface RagMediaRemovedPayload {
  mediaId: string;
  ownerType: string;
  ownerId: string;
}
/**
 * The owner/collection coordinates every ingestion outcome carries, so a subscriber can attribute a
 * skip or a failure to the collection it belongs to — not just to a bare media id. Optional because
 * the delete path knows the owner but not the collection, and an `enqueue` failure may only have the
 * job's event.
 */
export interface RagMediaOutcomeContext {
  ownerType?: string;
  ownerId?: string;
  collection?: string;
  /** Citation-facing origin (the media record's `path`). */
  source?: string;
  size?: number;
}

export interface RagMediaSkippedPayload extends RagMediaOutcomeContext {
  mediaId: string;
  mimeType: string;
  reason: 'unsupported-type' | 'too-large' | 'empty-text';
}
export interface RagMediaFailedPayload extends RagMediaOutcomeContext {
  mediaId: string;
  error: string;
  mimeType?: string;
  /**
   * Which phase threw. A plain string, so it survives cloning and persistence — unlike the `cause`
   * on {@link import('./media-ingest-job.js').MediaIngestOutcome}, which is in-process only and is
   * deliberately absent here.
   *
   * Optional, unlike on the outcome: the enqueue-failure path in
   * {@link import('./agent-media-ingestion.service.js').AgentMediaIngestionService} publishes
   * `media.failed` when the job never reached a worker at all, so no phase ever ran and there is
   * honestly nothing to report.
   */
  kind?: MediaIngestFailureKind;
}

/**
 * The outcome coordinates of a media event, for the `skipped`/`failed` payloads. An attach event
 * carries the full set; a delete event only knows its owner.
 */
export function outcomeContext(
  event: MediaAttachEvent | MediaDeleteEvent,
): RagMediaOutcomeContext & { mediaId: string; mimeType?: string } {
  const attach = 'collection' in event ? event : undefined;
  return {
    mediaId: event.id,
    ownerType: event.ownerType,
    ownerId: event.ownerId,
    ...(attach !== undefined
      ? {
          collection: attach.collection,
          source: attach.path,
          size: attach.size,
          mimeType: attach.mimeType,
        }
      : {}),
  };
}

export function publishRagMediaIngested(payload: RagMediaIngestedPayload): void {
  emit('rag', 'media.ingested', payload);
}
export function publishRagMediaRemoved(payload: RagMediaRemovedPayload): void {
  emit('rag', 'media.removed', payload);
}
export function publishRagMediaSkipped(payload: RagMediaSkippedPayload): void {
  emit('rag', 'media.skipped', payload);
}
export function publishRagMediaFailed(payload: RagMediaFailedPayload): void {
  emit('rag', 'media.failed', payload);
}
