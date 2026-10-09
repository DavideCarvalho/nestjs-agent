import {
  AGENT_PRICING_STORE,
  type ModelProvider,
  type ModelsDevOptions,
} from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore, InMemoryPricingStore } from '@dudousxd/nestjs-agent-testing';
import { Global, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentModule } from './agent.module.js';
import { HeaderActorResolver } from './resolver/header-actor-resolver.js';

const CATALOG = {
  openai: { models: { 'gpt-4o-mini': { cost: { input: 0.15, output: 0.6 } } } },
};

function fakeFetch() {
  return vi.fn(
    async () => ({ ok: true, status: 200, json: async () => CATALOG }) as unknown as Response,
  );
}

const model: ModelProvider = {
  async runTurn() {
    return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  },
  describeModels: () => [
    { modelId: 'gpt-4o-mini', provider: 'openai', reportsCost: false },
    { modelId: 'secret-1', provider: 'acme', reportsCost: false },
  ],
};

async function boot(pricing: InMemoryPricingStore, priceCatalog?: ModelsDevOptions | false) {
  @Global()
  @Module({
    providers: [{ provide: AGENT_PRICING_STORE, useValue: pricing }],
    exports: [AGENT_PRICING_STORE],
  })
  class PricingModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [
      PricingModule,
      AgentModule.forRoot({
        model,
        store: new InMemoryAgentStore(),
        actorResolver: new HeaderActorResolver(),
        ...(priceCatalog !== undefined ? { priceCatalog } : {}),
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  // Shutdown awaits the background check, so the assertions see its result.
  await app.close();
}

afterEach(() => vi.restoreAllMocks());

describe('AgentModule boot pricing', () => {
  it('seeds missing prices from models.dev and warns about the model it could not price', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const pricing = new InMemoryPricingStore();
    const fetch = fakeFetch();
    await boot(pricing, { fetch });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await pricing.listCurrentPrices()).map((row) => row.modelId)).toEqual(['gpt-4o-mini']);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(
      lines.filter((line) => line.includes('No cost will be recorded for secret-1')),
    ).toHaveLength(1);
  });

  it('stays off the network under NODE_ENV=test unless priceCatalog is set', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const pricing = new InMemoryPricingStore();
    await boot(pricing);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await pricing.listCurrentPrices()).toEqual([]);
    vi.unstubAllEnvs();
  });
});
