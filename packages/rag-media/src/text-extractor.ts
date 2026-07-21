/**
 * Turns a file's raw bytes into the plain text that gets chunked, embedded, and indexed. The
 * extraction seam — so `-rag` itself stays format-agnostic. Ships text-family extractors; bring your
 * own for PDF/DOCX/etc. (register a parser on a {@link MimeTextExtractor}).
 */
export interface TextExtractor {
  extract(bytes: Buffer, mimeType: string): Promise<string>;
}

/** Thrown when no extractor is registered for a mime type — ingestion treats it as "skip, don't index". */
export class UnsupportedMimeTypeError extends Error {
  constructor(readonly mimeType: string) {
    super(`No text extractor registered for mime type "${mimeType}"`);
    this.name = 'UnsupportedMimeTypeError';
  }
}

/** How a single mime type (or `type/*` family) turns bytes into text. */
export type ExtractFn = (bytes: Buffer, mimeType: string) => string | Promise<string>;

/**
 * A {@link TextExtractor} that dispatches by mime type. Register exact types (`application/json`) or a
 * whole family (`text/*`); an exact match always wins over a family. Unregistered types throw
 * {@link UnsupportedMimeTypeError}. This is the extension point: `.register('application/pdf', pdfFn)`.
 */
export class MimeTextExtractor implements TextExtractor {
  private readonly exact = new Map<string, ExtractFn>();
  private readonly families: { prefix: string; fn: ExtractFn }[] = [];

  register(mimeType: string, fn: ExtractFn): this {
    if (mimeType.endsWith('/*')) {
      // "text/*" → match anything starting "text/"
      this.families.push({ prefix: mimeType.slice(0, -1), fn });
    } else {
      this.exact.set(mimeType.toLowerCase(), fn);
    }
    return this;
  }

  async extract(bytes: Buffer, mimeType: string): Promise<string> {
    // strip any `; charset=…` parameter and normalize
    const normalized = (mimeType.split(';')[0] ?? mimeType).trim().toLowerCase();
    const fn = this.resolve(normalized);
    if (fn === undefined) {
      throw new UnsupportedMimeTypeError(mimeType);
    }
    return fn(bytes, normalized);
  }

  private resolve(mimeType: string): ExtractFn | undefined {
    const exact = this.exact.get(mimeType);
    if (exact !== undefined) {
      return exact;
    }
    for (const family of this.families) {
      if (mimeType.startsWith(family.prefix)) {
        return family.fn;
      }
    }
    return undefined;
  }
}

/** Decode bytes as UTF-8 — the extractor for `text/*` and JSON. */
export function decodeUtf8(bytes: Buffer): string {
  return bytes.toString('utf8');
}

/**
 * Extension → mime type, for the common document formats. A fallback for when the upload path didn't
 * record a content type (S3 objects frequently arrive as `application/octet-stream` or nothing at
 * all), so ingestion can still pick the right extractor instead of skipping the file.
 *
 * Unknown extensions yield `application/octet-stream`, which no default extractor handles — the file
 * is skipped rather than indexed as garbage.
 */
const EXTENSION_MIME_TYPES: Record<string, string> = {
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  xml: 'text/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pdf: 'application/pdf',
};

export function mimeFromFileName(fileName: string): string {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_MIME_TYPES[extension] ?? 'application/octet-stream';
}

/** Decode UTF-8 then strip HTML: drop `<script>`/`<style>` bodies and tags, decode common entities. */
export function extractHtmlText(bytes: Buffer): string {
  return bytes
    .toString('utf8')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The default extractor: `text/*` and `application/json` decode as UTF-8, `text/html` is
 * tag-stripped, everything else throws {@link UnsupportedMimeTypeError} (so binary formats are
 * skipped rather than indexed as garbage). Extend it — `.register('application/pdf', myPdfExtractor)`.
 */
export function defaultTextExtractor(): MimeTextExtractor {
  return new MimeTextExtractor()
    .register('text/html', extractHtmlText)
    .register('text/*', decodeUtf8)
    .register('application/json', decodeUtf8);
}
