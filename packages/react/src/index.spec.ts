import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as entry from './index.js';

describe('package entry', () => {
  it('re-exports by name only', () => {
    // A wildcard re-export from a barrel hides from the bundler which names a consumer actually
    // uses, and has broken a downstream build in this ecosystem before.
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^export\s+\*/m);
  });

  it('exposes the transcript model alongside the components built on it', () => {
    expect(typeof entry.useChatTranscript).toBe('function');
    expect(typeof entry.useTranscriptItem).toBe('function');
    expect(typeof entry.useStickToBottom).toBe('function');
    expect(typeof entry.buildTranscriptBlocks).toBe('function');
    expect(typeof entry.MessageItemView).toBe('function');
    expect(typeof entry.MessageList).toBe('function');
  });
});
