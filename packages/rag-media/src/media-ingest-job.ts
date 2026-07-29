import { outcomeContext, publishRagMediaFailed } from './diagnostics.js';
import type { MediaAttachEvent, MediaDeleteEvent } from './media-events.js';
import {
  type MediaIngestFailureKind,
  type MediaIngestResult,
  type MediaIngestionDeps,
  ingestMediaFile,
  mediaIngestFailureKind,
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
  | {
      status: 'failed';
      /** The error's message. Unchanged — this is what it always was. */
      error: string;
      /**
       * WHICH PHASE failed, so a caller can branch retry-vs-terminal instead of re-throwing blind.
       * Required, not optional: a consumer switching on a return type should never have to handle a
       * fourth `undefined` case. See {@link MediaIngestFailureKind} for the phases and for why this
       * is not a `retryable` boolean.
       */
      kind: MediaIngestFailureKind;
      /**
       * The ORIGINAL thrown value — its class, its own `cause`, its status code — so a host can apply
       * its own retry policy (`cause instanceof ThrottlingException`) rather than parsing `error`.
       *
       * IN-PROCESS ONLY. It survives the return value and the `aviary:rag:media.failed` diagnostics
       * publish (both by reference) and nothing else. It is deliberately NOT on the diagnostics
       * payload's persisted fields: an `Error` JSON-stringifies to `{}`, so anything that clones or
       * writes the payload (Telescope, a log shipper, `rag_ingestion_log`) would store an empty
       * object where the interesting part used to be. Read it in the same process that ran the job;
       * across a process boundary, use `error` and `kind`.
       */
      cause?: unknown;
    };

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
    const kind = mediaIngestFailureKind(error);
    // `kind` rides along on the diagnostics payload (a plain string — free, and it gives a recorder
    // the phase); `cause` does not, because that payload gets cloned and persisted. See the
    // `cause` doc on MediaIngestOutcome.
    publishRagMediaFailed({ ...outcomeContext(job.event), error: message, kind });
    return { status: 'failed', error: message, kind, cause: error };
  }
}
