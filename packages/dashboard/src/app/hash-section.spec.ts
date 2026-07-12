import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTION, hashForSection, sectionFromHash } from './hash-section';

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
});

describe('hashForSection', () => {
  it('renders the `#/<section>` href for a section key', () => {
    expect(hashForSection('reliability')).toBe('#/reliability');
    expect(hashForSection('spend')).toBe('#/spend');
  });
});
