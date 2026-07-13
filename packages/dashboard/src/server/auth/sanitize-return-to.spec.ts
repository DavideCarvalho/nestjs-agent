import { describe, expect, it } from 'vitest';
import { sanitizeReturnTo } from './sanitize-return-to.js';

const BASE = '/ai-gateway';

describe('sanitizeReturnTo', () => {
  it('accepts a path within basePath', () => {
    expect(sanitizeReturnTo(BASE, '/ai-gateway/runs')).toBe('/ai-gateway/runs');
  });

  it('accepts basePath itself', () => {
    expect(sanitizeReturnTo(BASE, '/ai-gateway')).toBe('/ai-gateway');
  });

  it('accepts basePath with a query string', () => {
    expect(sanitizeReturnTo(BASE, '/ai-gateway?tab=approvals')).toBe('/ai-gateway?tab=approvals');
  });

  it('falls back to basePath when absent', () => {
    expect(sanitizeReturnTo(BASE, undefined)).toBe(BASE);
  });

  it('falls back to basePath for a non-string value', () => {
    expect(sanitizeReturnTo(BASE, 42)).toBe(BASE);
    expect(sanitizeReturnTo(BASE, null)).toBe(BASE);
  });

  it('rejects a protocol-relative URL (open-redirect attempt)', () => {
    expect(sanitizeReturnTo(BASE, '//evil.example.com')).toBe(BASE);
  });

  it('rejects an absolute URL with a scheme', () => {
    expect(sanitizeReturnTo(BASE, 'https://evil.example.com/ai-gateway')).toBe(BASE);
  });

  it('rejects a path outside basePath', () => {
    expect(sanitizeReturnTo(BASE, '/admin')).toBe(BASE);
    // A path that merely starts with the SAME PREFIX (no separator) must not be treated as "inside".
    expect(sanitizeReturnTo(BASE, '/ai-gateway-evil')).toBe(BASE);
  });
});
