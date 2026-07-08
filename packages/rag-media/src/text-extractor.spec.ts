import { describe, expect, it } from 'vitest';
import {
  MimeTextExtractor,
  UnsupportedMimeTypeError,
  defaultTextExtractor,
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
