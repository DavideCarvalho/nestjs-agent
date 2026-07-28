import { describe, expect, it } from 'vitest';
import {
  MimeTextExtractor,
  UnsupportedMimeTypeError,
  defaultTextExtractor,
  normalizeMimeType,
} from './text-extractor.js';

describe('defaultTextExtractor', () => {
  const extractor = defaultTextExtractor();

  it('decodes text/plain as UTF-8', async () => {
    expect(await extractor.extract(Buffer.from('hello café', 'utf8'), 'text/plain')).toBe(
      'hello café',
    );
  });

  it('decodes text/markdown and text/csv via the text/* family', async () => {
    expect(await extractor.extract(Buffer.from('# Title'), 'text/markdown')).toBe('# Title');
    expect(await extractor.extract(Buffer.from('a,b,c'), 'text/csv')).toBe('a,b,c');
  });

  it('decodes application/json', async () => {
    expect(await extractor.extract(Buffer.from('{"k":1}'), 'application/json')).toBe('{"k":1}');
  });

  it('ignores a charset parameter on the mime type', async () => {
    expect(await extractor.extract(Buffer.from('body'), 'text/plain; charset=utf-8')).toBe('body');
  });

  it('strips tags, scripts, and entities from text/html', async () => {
    const html = Buffer.from(
      '<html><head><style>.x{color:red}</style><script>evil()</script></head>' +
        '<body><h1>Hi&amp;Bye</h1><p>Line&nbsp;one</p></body></html>',
    );
    const text = await extractor.extract(html, 'text/html');
    expect(text).toBe('Hi&Bye Line one');
    expect(text).not.toContain('evil');
    expect(text).not.toContain('color:red');
  });

  it('throws UnsupportedMimeTypeError for binary formats (so ingestion skips them)', async () => {
    await expect(
      extractor.extract(Buffer.from([0, 1, 2]), 'application/pdf'),
    ).rejects.toBeInstanceOf(UnsupportedMimeTypeError);
  });
});

describe('MimeTextExtractor', () => {
  it('prefers an exact match over a family match', async () => {
    const extractor = new MimeTextExtractor()
      .register('text/*', () => 'family')
      .register('text/special', () => 'exact');
    expect(await extractor.extract(Buffer.from(''), 'text/special')).toBe('exact');
    expect(await extractor.extract(Buffer.from(''), 'text/other')).toBe('family');
  });

  it('is extensible with a custom parser', async () => {
    const extractor = defaultTextExtractor().register('application/pdf', () => 'parsed pdf text');
    expect(await extractor.extract(Buffer.from([0]), 'application/pdf')).toBe('parsed pdf text');
  });
});

describe('MimeTextExtractor mime-type parameters', () => {
  // A Content-Type header legitimately carries `; charset=…`; RFC 2045 says the media type is the part
  // before the first `;`. Losing these resolves as "unsupported" → ingestion skips → the document
  // disappears with nothing surfaced to the operator.
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  const extractor = () =>
    defaultTextExtractor()
      .register(XLSX, () => 'sheet text')
      .register('application/csv', () => 'csv text');

  it('resolves an exact type carrying a charset parameter', async () => {
    expect(await extractor().extract(Buffer.from([0]), `${XLSX}; charset=utf-8`)).toBe(
      'sheet text',
    );
    expect(await extractor().extract(Buffer.from([0]), 'application/csv; charset=utf-8')).toBe(
      'csv text',
    );
  });

  it('resolves with or without a space after the semicolon', async () => {
    expect(await extractor().extract(Buffer.from([0]), 'application/csv;charset=utf-8')).toBe(
      'csv text',
    );
    expect(await extractor().extract(Buffer.from([0]), 'application/csv; charset=utf-8')).toBe(
      'csv text',
    );
  });

  it('resolves a non-charset parameter too', async () => {
    expect(await extractor().extract(Buffer.from([0]), 'application/csv; boundary=xyz')).toBe(
      'csv text',
    );
  });

  it('lowercases the incoming type', async () => {
    expect(await extractor().extract(Buffer.from([0]), 'APPLICATION/CSV')).toBe('csv text');
    expect(await extractor().extract(Buffer.from([0]), 'Application/CSV; Charset=UTF-8')).toBe(
      'csv text',
    );
  });

  it('still resolves a plain type unchanged', async () => {
    expect(await extractor().extract(Buffer.from([0]), 'application/csv')).toBe('csv text');
    expect(await extractor().extract(Buffer.from('hi'), 'text/plain')).toBe('hi');
  });

  it('still resolves the text/* family with parameters', async () => {
    expect(await extractor().extract(Buffer.from('a,b'), 'text/csv;charset=utf-8')).toBe('a,b');
    expect(await extractor().extract(Buffer.from('# T'), 'TEXT/MARKDOWN; charset=utf-8')).toBe(
      '# T',
    );
  });

  it('passes the normalized type to the extract fn, not the raw header', async () => {
    const seen: string[] = [];
    const extractor = new MimeTextExtractor().register('application/csv', (_bytes, mimeType) => {
      seen.push(mimeType);
      return '';
    });
    await extractor.extract(Buffer.from([0]), 'APPLICATION/CSV; charset=utf-8');
    expect(seen).toEqual(['application/csv']);
  });

  it('still throws for an unrelated unsupported type, parameters or not', async () => {
    await expect(extractor().extract(Buffer.from([0]), 'application/zip')).rejects.toBeInstanceOf(
      UnsupportedMimeTypeError,
    );
    await expect(
      extractor().extract(Buffer.from([0]), 'application/zip; charset=utf-8'),
    ).rejects.toBeInstanceOf(UnsupportedMimeTypeError);
  });

  it('reports the raw type on the error, so the operator sees what was actually passed', async () => {
    await expect(
      extractor().extract(Buffer.from([0]), 'application/zip; charset=utf-8'),
    ).rejects.toThrow('application/zip; charset=utf-8');
  });

  // Registration keys go through the same normalization: otherwise these store a key no lookup can
  // ever hit — a dead extractor that reads as "unsupported", i.e. a silent skip.
  it('normalizes registration keys: uppercase exact type', async () => {
    const extractor = new MimeTextExtractor().register('APPLICATION/CSV', () => 'csv text');
    expect(await extractor.extract(Buffer.from([0]), 'application/csv')).toBe('csv text');
  });

  it('normalizes registration keys: uppercase family', async () => {
    const extractor = new MimeTextExtractor().register('TEXT/*', () => 'family');
    expect(await extractor.extract(Buffer.from([0]), 'text/plain')).toBe('family');
  });

  it('normalizes registration keys: a parameter on the registered type', async () => {
    const extractor = new MimeTextExtractor().register(
      'application/csv; charset=utf-8',
      () => 'csv text',
    );
    expect(await extractor.extract(Buffer.from([0]), 'application/csv')).toBe('csv text');
    expect(await extractor.extract(Buffer.from([0]), 'application/csv; charset=latin1')).toBe(
      'csv text',
    );
  });
});

describe('normalizeMimeType', () => {
  it('keeps the media type before the first `;`, trimmed and lowercased', () => {
    expect(normalizeMimeType('text/csv')).toBe('text/csv');
    expect(normalizeMimeType('text/csv; charset=utf-8')).toBe('text/csv');
    expect(normalizeMimeType('text/csv;charset=utf-8')).toBe('text/csv');
    expect(normalizeMimeType('  TEXT/CSV ; charset=utf-8')).toBe('text/csv');
    expect(normalizeMimeType('multipart/form-data; boundary=x; charset=utf-8')).toBe(
      'multipart/form-data',
    );
    expect(normalizeMimeType('text/*')).toBe('text/*');
    expect(normalizeMimeType('')).toBe('');
  });
});
