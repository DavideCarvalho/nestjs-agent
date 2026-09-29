import { describe, expect, it } from 'vitest';
import { fillTemplate, phraseFor, readPath, toolCatalogFrom } from './phrasing.js';

const presentation = {
  label: 'Bucket read',
  running: 'Reading {bucket}',
  done: 'Read {bucket} ({stats.count} files)',
};

describe('readPath', () => {
  it('reads dotted paths and answers undefined for anything missing', () => {
    expect(readPath({ a: { b: 2 } }, 'a.b')).toBe(2);
    expect(readPath({ a: 1 }, 'a.b')).toBeUndefined();
    expect(readPath(null, 'a')).toBeUndefined();
  });
});

describe('fillTemplate', () => {
  it('fills placeholders from the context, joining arrays', () => {
    expect(fillTemplate('Reading {bucket} for {tags}', { bucket: 'logs', tags: ['a', 'b'] })).toBe(
      'Reading logs for a, b',
    );
  });

  it('collapses a placeholder with nothing behind it, and its leading space', () => {
    expect(fillTemplate('Reading {bucket} now', {})).toBe('Reading now');
    expect(fillTemplate('Reading {nested.obj}', { nested: { obj: { x: 1 } } })).toBe('Reading');
  });
});

describe('phraseFor', () => {
  it('uses running while in flight and done once settled', () => {
    expect(phraseFor(presentation, { bucket: 'logs' }, false)).toBe('Reading logs');
    expect(phraseFor(presentation, { bucket: 'logs', stats: { count: 3 } }, true)).toBe(
      'Read logs (3 files)',
    );
  });

  it('falls back to the label when every slot is still empty', () => {
    expect(phraseFor({ ...presentation, running: '{bucket}' }, {}, false)).toBe('Bucket read');
  });

  it('never names an undescribed tool — it narrates generically', () => {
    expect(phraseFor(undefined, {}, false)).toBe('Working');
    expect(phraseFor(undefined, {}, true)).toBe('Done');
    expect(phraseFor(undefined, {}, true, { running: 'En curso', done: 'Hecho' })).toBe('Hecho');
  });
});

describe('toolCatalogFrom', () => {
  it('indexes the entries that declared a presentation', () => {
    expect(
      toolCatalogFrom([
        { name: 'read', kind: 'read', presentation },
        { name: 'plain', kind: 'read' },
      ]),
    ).toEqual({ read: presentation });
  });
});
