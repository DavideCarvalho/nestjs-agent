import { describe, expect, it } from 'vitest';
import { injectLimit } from './limit.js';

describe('injectLimit', () => {
  it('wraps a query that has no LIMIT', () => {
    expect(injectLimit('SELECT id FROM vehicle;', 100)).toBe(
      'SELECT * FROM (SELECT id FROM vehicle) AS subq LIMIT 100',
    );
  });

  it('leaves a LIMIT within the cap alone', () => {
    expect(injectLimit('SELECT id FROM vehicle LIMIT 10', 100)).toBe(
      'SELECT id FROM vehicle LIMIT 10',
    );
    expect(injectLimit('SELECT id FROM vehicle LIMIT 10 OFFSET 500', 100)).toBe(
      'SELECT id FROM vehicle LIMIT 10 OFFSET 500',
    );
  });

  it('caps an explicit LIMIT above the cap, in either spelling', () => {
    expect(injectLimit('SELECT id FROM vehicle LIMIT 1000000', 100)).toBe(
      'SELECT * FROM (SELECT id FROM vehicle LIMIT 1000000) AS subq LIMIT 100',
    );
    expect(injectLimit('SELECT id FROM vehicle LIMIT 5, 1000000', 100)).toContain(
      'AS subq LIMIT 100',
    );
    expect(injectLimit('SELECT id FROM vehicle LIMIT 1000000 OFFSET 5', 100)).toContain(
      'AS subq LIMIT 100',
    );
  });
});
