import { emit } from '@dudousxd/nestjs-diagnostics';

/**
 * Diagnostics this package publishes on `aviary:rag:*`, so ingestion is observable (Telescope's
 * generic bridge captures them) without instrumenting your code. `emit` is free when nobody listens.
 */
export interface RagMediaIngestedPayload {
  mediaId: string;
  ownerType: string;
  ownerId: string;
  collection: string;
  chunks: number;
}
export interface RagMediaRemovedPayload {
  mediaId: string;
  ownerType: string;
  ownerId: string;
}
export interface RagMediaSkippedPayload {
  mediaId: string;
  mimeType: string;
  reason: 'unsupported-type' | 'too-large' | 'empty-text';
}
export interface RagMediaFailedPayload {
  mediaId: string;
  error: string;
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
