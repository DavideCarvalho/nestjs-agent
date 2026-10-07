import { OpenCode } from '@opencode/client';
import type { OpenCodeClient } from '../client.js';

/** Compile-time check: the real OpenCode 2 client satisfies the engine's structural client. */
export function realClient(baseUrl: string, password: string): OpenCodeClient {
  return OpenCode.make({
    baseUrl,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
  });
}
