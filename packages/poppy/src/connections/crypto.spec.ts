import { describe, expect, it } from 'vitest';
import { Sealer } from './crypto.js';

describe('Sealer', () => {
  it('round-trips, and refuses a tampered value or another secret', () => {
    const sealer = new Sealer('s'.repeat(32));
    const sealed = sealer.seal({ refreshToken: 'rt_secret' });
    expect(sealed).not.toContain('rt_secret');
    expect(sealer.open(sealed)).toEqual({ refreshToken: 'rt_secret' });
    const parts = sealed.split('.');
    parts[3] = `${parts[3]?.slice(0, -2)}AA`;
    expect(() => sealer.open(parts.join('.'))).toThrow();
    expect(() => new Sealer('t'.repeat(32)).open(sealed)).toThrow();
    expect(() => new Sealer('short')).toThrow(/16/);
  });

  it('seals the same value differently each time (a fresh IV)', () => {
    const sealer = new Sealer('s'.repeat(32));
    expect(sealer.seal('x')).not.toBe(sealer.seal('x'));
    expect(() => sealer.open('v2.a.b.c')).toThrow(/unknown sealed format/);
  });
});
