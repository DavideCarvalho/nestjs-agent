export interface ChunkOptions {
  /** Target max characters per chunk. Default 800. */
  chunkSize?: number;
  /** Characters of overlap carried from the end of one chunk into the next. Default 100. */
  overlap?: number;
}

/**
 * Splits text into overlapping chunks for embedding. Greedy up to `chunkSize`, but prefers to break
 * on a paragraph → sentence → word boundary in the back half of the window (so a chunk rarely cuts
 * mid-sentence), then carries `overlap` characters into the next chunk to preserve context across
 * the seam. Pure and deterministic.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const chunkSize = options.chunkSize ?? 800;
  const overlap = options.overlap ?? 100;
  const normalized = text.trim();
  if (normalized.length === 0) {
    return [];
  }
  if (normalized.length <= chunkSize) {
    return [normalized];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(start + chunkSize, normalized.length);
    let breakAt = end;
    if (end < normalized.length) {
      const window = normalized.slice(start, end);
      const boundary = Math.max(
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('. '),
        window.lastIndexOf(' '),
      );
      // Only honour a boundary in the back half, else a tiny chunk cascades.
      if (boundary > chunkSize / 2) {
        breakAt = start + boundary + 1;
      }
    }
    const chunk = normalized.slice(start, breakAt).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    if (breakAt >= normalized.length) {
      break;
    }
    // Step forward with overlap, but always make progress (guards against a stuck boundary).
    start = Math.max(breakAt - overlap, start + 1);
  }
  return chunks;
}
