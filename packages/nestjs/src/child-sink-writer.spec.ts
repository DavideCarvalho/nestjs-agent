import type { SinkWriter } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it, vi } from 'vitest';
import { childSinkWriter } from './agent-deps.js';

describe('childSinkWriter', () => {
  it('forwards writes, never ends or fails the shared stream, but flushes what the child wrote', async () => {
    const inner = {
      write: vi.fn(),
      end: vi.fn(),
      fail: vi.fn(),
      flush: vi.fn(),
    } satisfies SinkWriter;
    const child = childSinkWriter(inner);
    const chunk = new Uint8Array([1]);
    await child.write(chunk);
    await child.end();
    await child.fail({ code: 'run_failed', message: 'x' });
    expect(inner.write).toHaveBeenCalledWith(chunk);
    expect(inner.end).not.toHaveBeenCalled();
    expect(inner.fail).not.toHaveBeenCalled();
    expect(inner.flush).toHaveBeenCalledTimes(2);
  });

  it('is fine over a writer that has nothing to flush', async () => {
    const child = childSinkWriter({ write: vi.fn(), end: vi.fn(), fail: vi.fn() });
    await expect(child.end()).resolves.toBeUndefined();
  });
});
