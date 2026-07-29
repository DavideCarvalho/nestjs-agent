import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTION, hashForSection, routeFromHash, sectionFromHash } from './hash-section';

describe('sectionFromHash', () => {
  it('falls back to the default section for an empty hash', () => {
    expect(sectionFromHash('')).toBe(DEFAULT_SECTION);
  });

  it('resolves a well-formed `#/<section>` hash', () => {
    expect(sectionFromHash('#/reliability')).toBe('reliability');
    expect(sectionFromHash('#/approvals')).toBe('approvals');
  });

  it('resolves a hash missing the leading slash', () => {
    expect(sectionFromHash('#reliability')).toBe('reliability');
  });

  it('falls back to the default section for an unknown slug', () => {
    expect(sectionFromHash('#/bogus-section')).toBe(DEFAULT_SECTION);
  });

  it('falls back to the default section for a bare "#"', () => {
    expect(sectionFromHash('#')).toBe(DEFAULT_SECTION);
  });

  it('ignores a query tail when resolving the section', () => {
    expect(sectionFromHash('#/reliability?threadId=th2')).toBe('reliability');
  });
});

describe('routeFromHash', () => {
  it('returns empty params for a hash with no query tail', () => {
    const route = routeFromHash('#/reliability');
    expect(route.section).toBe('reliability');
    expect([...route.params]).toEqual([]);
  });

  it('parses the query tail into params', () => {
    const route = routeFromHash('#/reliability?threadId=th2&status=failed');
    expect(route.section).toBe('reliability');
    expect(route.params.get('threadId')).toBe('th2');
    expect(route.params.get('status')).toBe('failed');
  });

  it('decodes a percent-encoded param value', () => {
    expect(routeFromHash('#/reliability?threadId=a%2Fb').params.get('threadId')).toBe('a/b');
  });

  // Params are only meaningful to the section that declared them; carrying them onto the fallback
  // would apply a filter to a section that never asked for one.
  it('drops the params when the section slug is unknown', () => {
    const route = routeFromHash('#/bogus?threadId=th2');
    expect(route.section).toBe(DEFAULT_SECTION);
    expect([...route.params]).toEqual([]);
  });
});

describe('hashForSection', () => {
  it('renders the `#/<section>` href for a section key', () => {
    expect(hashForSection('reliability')).toBe('#/reliability');
    expect(hashForSection('spend')).toBe('#/spend');
  });

  it('appends a query tail when params are given', () => {
    expect(hashForSection('reliability', { threadId: 'th2' })).toBe('#/reliability?threadId=th2');
  });

  it('omits the tail for an empty params object', () => {
    expect(hashForSection('reliability', {})).toBe('#/reliability');
  });

  it('round-trips through routeFromHash', () => {
    const href = hashForSection('reliability', { threadId: 'a/b' });
    expect(routeFromHash(href).params.get('threadId')).toBe('a/b');
  });
});
