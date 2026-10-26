import type { Response } from 'express';

/**
 * Subscribe options that abort once the response's connection closes — the reader went away, or
 * the response finished (when aborting has nothing left to stop).
 */
export function readerGone(res: Response): { signal: AbortSignal } {
  const controller = new AbortController();
  res.once('close', () => controller.abort());
  return { signal: controller.signal };
}
