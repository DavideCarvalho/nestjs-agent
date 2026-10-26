import { afterEach, describe, expect, it } from 'vitest';
import { detectKeywords, detectRegex, fold } from './custom.js';

describe('custom detectors', () => {
  it('regex with (?i) and label', () => {
    const f = detectRegex('Projeto AURORA e projeto aurora', ['(?i)projeto\\s+aurora'], 'codename');
    expect(f.map((x) => [x.category, x.value])).toEqual([
      ['regex.codename', 'Projeto AURORA'],
      ['regex.codename', 'projeto aurora'],
    ]);
  });

  it('invalid patterns are skipped, empty matches do not loop', () => {
    expect(detectRegex('abc', ['(', 'x*'])).toEqual([]);
  });

  it('keywords are whole-word, case- and accent-insensitive, offsets map to the original', () => {
    const text = 'Fusão com a ACME é confidencial; fusao não é fusãozinha.';
    const f = detectKeywords(text, ['fusão', 'confidencial'], 'deal');
    expect(f.map((x) => x.value)).toEqual(['Fusão', 'confidencial', 'fusao']);
    for (const x of f) expect(text.slice(x.start, x.end)).toBe(x.value);
    expect(fold('Ação')).toBe('acao');
  });

  describe('compiling', () => {
    const NativeRegExp = globalThis.RegExp;
    afterEach(() => {
      globalThis.RegExp = NativeRegExp;
    });

    it('compiles a keyword list once, however many texts it scans', () => {
      let compiled = 0;
      globalThis.RegExp = new Proxy(NativeRegExp, {
        construct(target, args) {
          compiled += 1;
          return Reflect.construct(target, args);
        },
      });
      const words = ['orçamento', 'demissão'];
      for (let i = 0; i < 50; i++) {
        expect(detectKeywords(`o orcamento ${i} e a demissão`, [...words])).toHaveLength(2);
      }
      expect(compiled).toBeLessThanOrEqual(1);
    });
  });
});
