import type { MediaAttachEvent, MediaDeleteEvent } from './media-events.js';
import { type MediaIngestionDeps, ingestMediaFile, removeMedia } from './media-ingestion.js';

/** A unit of media→RAG work, so ingestion can be handed to a durable queue for at-least-once. */
export type MediaIngestJob =
  | { type: 'ingest'; event: MediaAttachEvent }
  | { type: 'remove'; event: MediaDeleteEvent };

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
