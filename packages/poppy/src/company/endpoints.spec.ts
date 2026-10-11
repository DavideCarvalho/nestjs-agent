import { AgentModule } from '@dudousxd/nestjs-agent';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentPoppyModule } from './agent-poppy.module.js';
import type { AgentPoppyModuleOptions } from './agent-poppy.options.js';
import { POPPY_AUTHENTICATE_SLOT } from './auth.js';
import {
  POPPY_ENDPOINTS_SLOT,
  announcePoppyEndpoints,
  announcedPoppyEndpoints,
  poppyConversationsUrl,
} from './endpoints.js';
import { fakeResolver } from './poppy.spec-helper.js';

/** Boot the modules without an HTTP server — what the module does at init. */
async function init(options: AgentPoppyModuleOptions) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(() => ({ text: 'ok' })),
        store: new InMemoryAgentStore(),
      }),
      AgentPoppyModule.forRoot(options),
    ],
  }).compile();
  await moduleRef.init();
  await moduleRef.close();
}

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[POPPY_ENDPOINTS_SLOT];
  delete (globalThis as Record<symbol, unknown>)[POPPY_AUTHENTICATE_SLOT];
  vi.restoreAllMocks();
});

describe('Poppy endpoint announcement (for poppy.json)', () => {
  it('builds the absolute conversation URL', () => {
    expect(poppyConversationsUrl('https://api.acme.com/', '/poppy/conversations/')).toBe(
      'https://api.acme.com/poppy/conversations',
    );
  });

  it('merges into the slot, keeping what is already there', () => {
    (globalThis as Record<symbol, unknown>)[POPPY_ENDPOINTS_SLOT] = { other: 'https://x/o' };
    announcePoppyEndpoints({ conversations: 'https://x/c' });
    expect(announcedPoppyEndpoints()).toEqual({
      other: 'https://x/o',
      conversations: 'https://x/c',
    });
  });

  it('the module announces {baseUrl}/{path} at boot', async () => {
    (globalThis as Record<symbol, unknown>)[POPPY_ENDPOINTS_SLOT] = { other: 'https://x/o' };
    await init({ baseUrl: 'https://api.acme.com/', path: 'poppy/v1', authenticate: fakeResolver });
    expect((globalThis as Record<symbol, unknown>)[POPPY_ENDPOINTS_SLOT]).toEqual({
      other: 'https://x/o',
      conversations: 'https://api.acme.com/poppy/v1',
    });
  });

  it('defaults the path, and announces nothing without baseUrl', async () => {
    await init({ baseUrl: 'https://api.acme.com', authenticate: fakeResolver });
    expect(announcedPoppyEndpoints().conversations).toBe(
      'https://api.acme.com/poppy/conversations',
    );
    delete (globalThis as Record<symbol, unknown>)[POPPY_ENDPOINTS_SLOT];
    await init({ agent: 'support', authenticate: fakeResolver });
    expect(announcedPoppyEndpoints()).toEqual({});
  });
});

describe('Poppy boot warnings', () => {
  it('warns when no one can verify a Session Token, and not once a resolver is installed', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    await init({});
    const said = () => warn.mock.calls.map((call) => String(call[0]));
    expect(said().some((line) => line.includes('no Session Token resolver'))).toBe(true);
    // The in-memory fallback store is a warning too: conversations would not survive a restart.
    expect(said().some((line) => line.includes('no PoppyStore'))).toBe(true);

    warn.mockClear();
    (globalThis as Record<symbol, unknown>)[POPPY_AUTHENTICATE_SLOT] = fakeResolver;
    await init({});
    expect(said().some((line) => line.includes('no Session Token resolver'))).toBe(false);
  });

  it('refuses to boot without an AgentService to answer', async () => {
    await expect(
      Test.createTestingModule({ imports: [AgentPoppyModule.forRoot({})] }).compile(),
    ).rejects.toThrow(/AgentModule/);
  });
});
