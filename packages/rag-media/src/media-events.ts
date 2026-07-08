/**
 * The two `@dudousxd/nestjs-media` diagnostics payloads this package reads, re-declared here so the
 * integration couples to the *wire contract* (the `aviary:media:*` channel) rather than importing the
 * media package. These mirror media's `AttachPayload` / `DeletePayload` — keep them in sync with that
 * library's `@dudousxd/nestjs-media`'s core `diagnostics.ts`.
 */

/** Emitted on `aviary:media:attach` when a file is attached to an owner record. */
export interface MediaAttachEvent {
  /** The media-library record id — used as the RAG document id (chunk ids `${id}#<n>`). */
  id: string;
  ownerType: string;
  ownerId: string;
  collection: string;
  /** The storage disk name the bytes live on — passed to the host's `readFile`. */
  disk: string;
  /** The path within the disk — passed to the host's `readFile`, and the passage `source`. */
  path: string;
  size: number;
  mimeType: string;
}

/** Emitted on `aviary:media:delete` when an attached record is removed. */
export interface MediaDeleteEvent {
  id: string;
  ownerType: string;
  ownerId: string;
}

/** The `@dudousxd/nestjs-diagnostics` envelope shape — the integration only reads `payload`. */
interface DiagnosticEnvelope {
  payload: unknown;
}

/** Pull `.payload` off a diagnostics-channel message without an unguarded cast. */
export function envelopePayload(message: unknown): unknown {
  if (typeof message === 'object' && message !== null && 'payload' in message) {
    return (message as DiagnosticEnvelope).payload;
  }
  return undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isMediaAttachEvent(payload: unknown): payload is MediaAttachEvent {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const candidate = payload as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.id) &&
    isNonEmptyString(candidate.ownerType) &&
    isNonEmptyString(candidate.ownerId) &&
    isNonEmptyString(candidate.collection) &&
    isNonEmptyString(candidate.disk) &&
    isNonEmptyString(candidate.path) &&
    typeof candidate.size === 'number' &&
    isNonEmptyString(candidate.mimeType)
  );
}

export function isMediaDeleteEvent(payload: unknown): payload is MediaDeleteEvent {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const candidate = payload as Record<string, unknown>;
  return isNonEmptyString(candidate.id);
}
