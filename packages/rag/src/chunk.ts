export interface ChunkOptions {
  /** Target max characters per chunk. Default 800. */
  chunkSize?: number;
  /** Characters of overlap carried from the end of one chunk into the next. Default 100. */
  overlap?: number;
  /**
   * Treat the text as records joined by this string, and never split one across chunks.
   *
   * Default chunking is structure-blind: it breaks at the *latest* paragraph/sentence/word boundary
   * in the window, which for record-shaped text means a cut lands mid-record routinely. That is fine
   * for prose, where the two halves are still sentences. It is not fine for a table flattened to one
   * record per row, because the half that keeps the row identifier and the half that keeps the value
   * end up in different chunks, and neither can answer a question about that row on its own.
   *
   * With a separator set, whole records are packed greedily up to `chunkSize` and a record is never
   * cut — except one longer than `chunkSize`, which has nowhere to go and is character-split as
   * usual, since no chunker can avoid that.
   *
   * `overlap` is IGNORED in this mode, deliberately. Overlap exists to rescue a sentence that a
   * boundary cut in half; a boundary that never falls inside a record has nothing to rescue, and
   * carrying the tail of the previous chunk in would duplicate whole records into neighbouring chunks
   * — paying for the same rows twice at embedding time and letting one row match from two places.
   *
   * Measured on a 200-row spreadsheet flattened to one field-labelled record per row (15 columns,
   * ~800-char budget): blind chunking left 27% of records split, and on questions targeting a field
   * on the far side of such a cut, BM25 answered 54/66 (MRR 0.818) against 66/66 (MRR 1.000) with
   * records kept whole. The dense leg scored 7/66 either way — 200 near-identical rows produce
   * near-identical vectors, so that leg cannot do row lookup at all and chunking does not change it.
   */
  separator?: string;
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
  if (options.separator !== undefined && options.separator.length > 0) {
    return chunkByRecord(normalized, chunkSize, options.separator);
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

/**
 * Pack whole records up to `chunkSize`, never splitting one. See {@link ChunkOptions.separator}.
 *
 * A record longer than the budget is handed to the blind chunker, which is the honest fallback: it is
 * the same splitting that would have happened anyway, and it is confined to the one record that could
 * not fit rather than applied to the whole document.
 */
function chunkByRecord(text: string, chunkSize: number, separator: string): string[] {
  const chunks: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.length > 0) {
      chunks.push(current);
      current = '';
    }
  };
  for (const record of text.split(separator)) {
    const trimmed = record.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed.length > chunkSize) {
      flush();
      // `separator: undefined` on purpose — this is the blind path, for the one record that cannot
      // fit whole. Overlap stays off so the fallback does not reintroduce duplication the mode exists
      // to avoid.
      chunks.push(...chunkText(trimmed, { chunkSize, overlap: 0 }));
      continue;
    }
    const candidate = current.length > 0 ? `${current}${separator}${trimmed}` : trimmed;
    if (candidate.length > chunkSize) {
      flush();
      current = trimmed;
    } else {
      current = candidate;
    }
  }
  flush();
  return chunks;
}
