import 'reflect-metadata';
import {
  AGENT_PRICING_STORE,
  type Actor,
  type RecordUsageInput,
  estimateCost,
} from '@dudousxd/nestjs-agent-core';
import { InMemoryPricingStore } from '@dudousxd/nestjs-agent-testing';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore } from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { afterEach, describe, expect, it } from 'vitest';
import { openCodeDurable } from './durable/index.js';
import { openCode } from './engine.js';
import type { OpenCodeRunResult } from './host.js';
import type { FakeScript, FakeTurn } from './testing/fake-opencode.js';
import { type Harness, bootEngine, eventually, frames, framesUntil } from './testing/harness.js';
import type { OpenCodeEngineSettings } from './turns.js';
import { OpenCodeTurns } from './turns.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };
const GOV_SONNET = 'us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0';
/** The published us-gov-west-1 price of Claude Sonnet 4.5 (the library's built-in table). */
const GOV_PRICE = {
  inputPricePer1m: 3.6,
  outputPricePer1m: 18,
  cacheReadPricePer1m: 0.36,
  cacheWritePricePer1m: 4.5,
};
/** What OpenCode reports for a step: the uncached input, and the cache beside it. */
const TOKENS = { input: 3, output: 217, reasoning: 0, cache: { read: 1000, write: 10085 } };
/** The same step as the library counts it: the whole input side, cache included. */
const USAGE = {
  inputTokens: 3 + 1000 + 10085,
  outputTokens: 217,
  cacheReadTokens: 1000,
  cacheWriteTokens: 10085,
};
const GOV_COST = (3 * 3.6 + 217 * 18 + 1000 * 0.36 + 10085 * 4.5) / 1_000_000;

function bedrockStep(t: FakeTurn, cost: number, tokens: Record<string, unknown> = TOKENS) {
  t.emit('session.step.started', { model: { providerID: 'amazon-bedrock', id: GOV_SONNET } });
  t.emit('session.step.ended', { tokens, cost });
}

/** Every usage row the engine writes. */
function ledger(h: Harness): RecordUsageInput[] {
  const rows: RecordUsageInput[] = [];
  const record = h.store.recordUsage.bind(h.store);
  h.store.recordUsage = async (input) => {
    rows.push(input);
    await record(input);
  };
  return rows;
}

function pricingModule(store: InMemoryPricingStore): DynamicModule {
  @Global()
  @Module({
    providers: [{ provide: AGENT_PRICING_STORE, useValue: store }],
    exports: [AGENT_PRICING_STORE],
  })
  class PricingModule {}
  return { module: PricingModule };
}

describe('OpenCode turns: cost and usage', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.app.close();
    h = undefined;
  });

  async function boot(
    script: FakeScript,
    settings: Partial<OpenCodeEngineSettings> = {},
    extra: { pricing?: InMemoryPricingStore; settled?: OpenCodeRunResult[] } = {},
  ) {
    h = await bootEngine({
      engine: (host) =>
        openCode({
          host: Object.assign(host, {
            onSettled: async (r: OpenCodeRunResult) => {
              extra.settled?.push(r);
            },
          }),
          ...settings,
        }),
      script,
      options: { priceCatalog: { region: 'us-gov-west-1', modelsDev: false } },
      ...(extra.pricing ? { imports: [pricingModule(extra.pricing)] } : {}),
    });
    return h;
  }

  it('estimates a step OpenCode priced at 0 at the GovCloud price, cache tokens included', async () => {
    const pricing = new InMemoryPricingStore();
    const settled: OpenCodeRunResult[] = [];
    await boot(
      async (t) => {
        t.emit('session.text.delta', { delta: 'Hi.' });
        bedrockStep(t, 0);
        t.succeed();
      },
      {},
      { pricing, settled },
    );
    const rows = ledger(h as Harness);
    const { runId, threadId } = await (h as Harness).service.chat({ actor, message: 'hi' });
    const fs = await frames((h as Harness).service, runId);
    await eventually(() => settled.length === 1, 'settled');

    expect(rows).toEqual([
      expect.objectContaining({
        purpose: 'chat',
        modelId: `amazon-bedrock/${GOV_SONNET}`,
        usage: USAGE,
        costSource: 'estimate',
        costUsd: expect.closeTo(GOV_COST, 12),
      }),
    ]);
    expect(estimateCost(USAGE, GOV_PRICE)).toBeCloseTo(GOV_COST, 12);
    // The step-finish frame carries the same figure.
    expect(fs.find((f) => f.kind === 'step-finish')).toMatchObject({
      costUsd: expect.closeTo(GOV_COST, 12),
      model: `amazon-bedrock/${GOV_SONNET}`,
    });
    // The price was seeded into the pricing store.
    expect((await pricing.listCurrentPrices()).map((p) => p.modelId)).toContain(GOV_SONNET);
    const answer = (await (h as Harness).store.getThread(threadId))?.messages.at(-1);
    expect(answer?.usage).toMatchObject({ ...USAGE, costUsd: expect.closeTo(GOV_COST, 12) });
    expect(settled[0]?.usage).toMatchObject({ ...USAGE, costUsd: expect.closeTo(GOV_COST, 12) });
  });

  it('records the cost OpenCode reported as the provider figure', async () => {
    await boot(async (t) => {
      bedrockStep(t, 0.05);
      t.succeed();
    });
    const rows = ledger(h as Harness);
    const { runId } = await (h as Harness).service.chat({ actor, message: 'hi' });
    await frames((h as Harness).service, runId);
    expect(rows).toEqual([expect.objectContaining({ costUsd: 0.05, costSource: 'provider' })]);
  });

  it("`cost: 'estimate'` prices at the library's price even when OpenCode reported one", async () => {
    await boot(
      async (t) => {
        bedrockStep(t, 0.05);
        t.succeed();
      },
      { cost: 'estimate' },
    );
    const rows = ledger(h as Harness);
    const { runId } = await (h as Harness).service.chat({ actor, message: 'hi' });
    await frames((h as Harness).service, runId);
    expect(rows).toEqual([
      expect.objectContaining({ costSource: 'estimate', costUsd: expect.closeTo(GOV_COST, 12) }),
    ]);
  });

  it('keeps OpenCode’s 0 for a model the library has no price for', async () => {
    await boot(async (t) => {
      t.emit('session.step.started', { model: { providerID: 'opencode-go', id: 'free-model' } });
      t.emit('session.step.ended', { tokens: { input: 10, output: 5 }, cost: 0 });
      t.succeed();
    });
    const rows = ledger(h as Harness);
    const { runId } = await (h as Harness).service.chat({ actor, message: 'hi' });
    await frames((h as Harness).service, runId);
    expect(rows).toEqual([
      expect.objectContaining({
        modelId: 'opencode-go/free-model',
        costUsd: 0,
        costSource: 'provider',
      }),
    ]);
  });

  it('records the title and compaction calls OpenCode makes, and counts them in the run', async () => {
    const settled: OpenCodeRunResult[] = [];
    await boot(
      async (t) => {
        bedrockStep(t, 0.01, {
          input: 100,
          output: 10,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        });
        t.emit('session.usage.recorded', {
          source: 'title',
          tokens: { input: 568, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0,
        });
        t.emit('session.usage.recorded', {
          source: 'compaction',
          tokens: { input: 50, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0.002,
        });
        t.succeed();
      },
      {},
      { settled },
    );
    const rows = ledger(h as Harness);
    const { runId } = await (h as Harness).service.chat({ actor, message: 'hi' });
    await frames((h as Harness).service, runId);
    await eventually(() => settled.length === 1, 'settled');
    const titleCost = (568 * 3.6 + 4 * 18) / 1_000_000;
    expect(rows.map((r) => [r.purpose, r.costSource])).toEqual([
      ['chat', 'provider'],
      ['title', 'estimate'],
      ['history_summary', 'provider'],
    ]);
    expect(rows[1]).toMatchObject({
      modelId: `amazon-bedrock/${GOV_SONNET}`,
      usage: { inputTokens: 568, outputTokens: 4 },
      costUsd: expect.closeTo(titleCost, 12),
    });
    expect(settled[0]?.usage).toMatchObject({
      inputTokens: 100 + 568 + 50,
      outputTokens: 10 + 4 + 20,
      costUsd: expect.closeTo(0.01 + titleCost + 0.002, 12),
    });
  });
});

describe('OpenCode turns: usage across a durable resume', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.app.close();
    h = undefined;
  });

  it('adds up what every process saw, cache tokens included, without reading the store', async () => {
    const settled: OpenCodeRunResult[] = [];
    h = await bootEngine({
      engine: (host) =>
        openCodeDurable({
          host: Object.assign(host, {
            onSettled: async (r: OpenCodeRunResult) => {
              settled.push(r);
            },
          }),
        }),
      script: async (t) => {
        t.emit('session.text.delta', { delta: 'Sending.' });
        bedrockStep(t, 0.03);
        t.emit('permission.asked', { id: 'per_1', action: 'company.gmail__send_email' });
        await t.next('permission.reply');
        t.emit('session.text.delta', { delta: 'Sent.' });
        bedrockStep(t, 0.02, {
          input: 2,
          output: 5,
          reasoning: 0,
          cache: { read: 11088, write: 0 },
        });
        t.succeed();
      },
      imports: [
        DurableModule.forRoot({
          store: new InMemoryStateStore(),
          transport: new EventEmitterTransport(new EventEmitter2()),
        }),
      ],
    });
    const { runId, threadId } = await h.service.chat({ actor, message: 'send it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    // What a restart leaves: no live turn, no listener — only the journal.
    h.app.get(OpenCodeTurns).drop(runId);
    // And a store that cannot tell the run's usage: the figure must not come from it.
    const getThread = h.store.getThread.bind(h.store);
    h.store.getThread = async (id, ...rest) => {
      const thread = await getThread(id, ...rest);
      return (
        thread && {
          ...thread,
          messages: thread.messages.map(({ usage: _u, ...m }) => m),
        }
      );
    };
    await h.service.approve(actor, 'per_1');
    await frames(h.service, runId);
    await eventually(() => settled.length === 1, 'settled');

    const expected = {
      inputTokens: USAGE.inputTokens + 2 + 11088,
      outputTokens: 217 + 5,
      cacheReadTokens: 1000 + 11088,
      cacheWriteTokens: 10085,
      costUsd: expect.closeTo(0.05, 12),
    };
    expect(settled[0]?.usage).toMatchObject(expected);
    // The answer the resumed process wrote carries the whole run, not only its own half.
    const answer = (await getThread(threadId))?.messages.at(-1);
    expect(answer?.usage).toMatchObject(expected);
  });
});
