import { describe, expect, it } from 'vitest';
import { parseRunInput, readForwardedProps } from './input.js';

describe('forwarded UI capabilities', () => {
  it('validates and snapshots exact capabilities alongside persona', () => {
    const components = [{ name: 'Card', version: 2 }];
    const result = readForwardedProps({ persona: 'reviewer', uiCapabilities: { components } });
    expect(result).toEqual({ persona: 'reviewer', uiCapabilities: { components } });
    const first = components[0];
    if (!first) throw new Error('Missing component');
    first.version = 3;
    expect(result.uiCapabilities?.components[0]?.version).toBe(2);
    expect(readForwardedProps({ uiCapabilities: { components: [] } })).toEqual({
      uiCapabilities: { components: [] },
    });
  });
  it('rejects malformed advertised capabilities instead of widening to legacy support', () => {
    for (const value of [null, {}, { components: [{ name: 'Card', version: 0 }] }]) {
      expect(() => readForwardedProps({ uiCapabilities: value })).toThrow();
    }
    expect(readForwardedProps({})).toEqual({});
  });
});

it('rejects malformed AG-UI capabilities at input parsing', () => {
  expect(
    parseRunInput({
      threadId: 'thread',
      runId: 'run',
      messages: [],
      forwardedProps: { uiCapabilities: null },
    }),
  ).toBe('forwardedProps.uiCapabilities must be valid UI capabilities');
});
