import { outcomeContext, publishRagMediaFailed } from './diagnostics.js';
import type { MediaAttachEvent, MediaDeleteEvent } from './media-events.js';
import {
  type MediaIngestResult,
  type MediaIngestionDeps,
  ingestMediaFile,
  removeMedia,
} from './media-ingestion.js';

/** A unit of media→RAG work, so ingestion can be handed to a durable queue for at-least-once. */
export type MediaIngestJob =
  | { type: 'ingest'; event: MediaAttachEvent }
  | { type: 'remove'; event: MediaDeleteEvent };

/**
 * Every terminal state of a job, including the two {@link ingestMediaFile} can't express: a removal,
 * and a thrown error. Subscribers that record ingestion outcomes need all four.
 */
export type MediaIngestOutcome =
  | MediaIngestResult
  | { status: 'removed' }
  | { status: 'failed'; error: string };

/** Run a {@link MediaIngestJob} — call this from your durable workflow when using the `enqueue` hook. */
export async function applyMediaIngestJob(
  job: MediaIngestJob,
  deps: MediaIngestionDeps,
): Promise<void> {
  if (job.type === 'ingest') {
    await ingestMediaFile(job.event, deps);
    return;
  }
  await removeMedia(job.event, { store: deps.store });
}

/**
 * {@link applyMediaIngestJob} with the error boundary attached: never throws, and publishes
 * `aviary:rag:media.failed` when the job blows up, so a failure is as observable as a success.
 *
 * Use this instead of calling {@link ingestMediaFile} directly whenever ingestion runs detached from
 * a caller that could handle the throw — a diagnostics-channel subscriber, a queue consumer, a
 * fire-and-forget upload hook. A raw `ingestMediaFile` that throws in one of those leaves no trace
 * beyond an unhandled rejection, and a document that silently never made it into the index.
 */
export async function runMediaIngestJob(
  job: MediaIngestJob,
  deps: MediaIngestionDeps,
): Promise<MediaIngestOutcome> {
  try {
    if (job.type === 'remove') {
      await removeMedia(job.event, { store: deps.store });
      return { status: 'removed' };
    }
    return await ingestMediaFile(job.event, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    publishRagMediaFailed({ ...outcomeContext(job.event), error: message });
    return { status: 'failed', error: message };
  }
}
