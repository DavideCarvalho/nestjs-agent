import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { type AgentUsageRecorded, PLATFORM_ACTOR_REF } from '@dudousxd/nestjs-agent-core';
import {
  FakeModelProvider,
  InMemoryAgentStore,
  InMemoryGovernanceQueries,
} from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentModule } from './agent.module.js';
import { AgentService } from './agent.service.js';
import { Agent } from './decorator/agent.decorator.js';
import { HeaderActorResolver } from './resolver/header-actor-resolver.js';

@Agent({ name: 'default', systemPrompt: 'usage test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

let close: (() => Promise<void>) | undefined;

async function boot() {
  const store = new InMemoryAgentStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(() => ({ text: 'ok' })),
        store,
        // The ledger is the budget here: the quota windows read the same rows.
        quota: { limits: { day: { tokens: 1_000_000 } } },
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'default',
      }),
    ],
    providers: [DefaultAgent],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  close = () => app.close();
  return { service: app.get(AgentService), store };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await close?.();
  close = undefined;
});

const today = () => new Date().toISOString().slice(0, 10);

describe('AgentService.recordUsage — AI spend from outside agent turns', () => {
  it('writes the ledger with no thread, publishes usage.recorded, and counts against the actor', async () => {
    const { service, store } = await boot();
    const events: AgentUsageRecorded[] = [];
    const name = 'aviary:agent:usage.recorded';
    const listener = (message: unknown) =>
      void events.push((message as { payload: AgentUsageRecorded }).payload);
    subscribe(name, listener);
    try {
      expect(
        await service.recordUsage({
          actorRef: 'alice',
          feature: 'transcription',
          modelId: 'whisper-1',
          provider: 'openai',
          audioSeconds: 60,
          costUsd: 0.006,
          metadata: { secret: 'never on the event' },
        }),
      ).toEqual({ recorded: true });
      await service.recordUsage({
        actorRef: 'alice',
        feature: 'spellcheck',
        modelId: 'gpt-4o-mini',
        inputTokens: 100,
        outputTokens: 20,
      });
      await service.recordUsage({
        actorRef: null,
        feature: 'tts',
        modelId: 'tts-1',
        characters: 10,
      });
    } finally {
      unsubscribe(name, listener);
    }
    expect(events[0]).toEqual({
      actorRef: 'alice',
      feature: 'transcription',
      purpose: 'external',
      modelId: 'whisper-1',
      provider: 'openai',
      inputTokens: 0,
      outputTokens: 0,
      audioSeconds: 60,
      costUsd: 0.006,
      costSource: 'provider',
    });
    expect(events[2]?.actorRef).toBe(PLATFORM_ACTOR_REF);
    expect(store.governanceUsage().every((row) => row.threadId === null)).toBe(true);
    const day = await store.quotaToday('alice', today());
    expect(day.usedTokens).toBe(120);
    expect(day.costUsd).toBeCloseTo(0.006, 8);
    const features = await new InMemoryGovernanceQueries(store).spendByFeature({
      fromDay: today(),
      toDay: today(),
    });
    expect(features.map((row) => row.feature).sort()).toEqual([
      'spellcheck',
      'transcription',
      'tts',
    ]);
  });

  it('records a call with no model as `unknown`, and an opt-out row outside the quota', async () => {
    const { service, store } = await boot();
    const events: AgentUsageRecorded[] = [];
    const name = 'aviary:agent:usage.recorded';
    const listener = (message: unknown) =>
      void events.push((message as { payload: AgentUsageRecorded }).payload);
    subscribe(name, listener);
    try {
      await service.recordUsage({ actorRef: 'alice', feature: 'rag-chat', inputTokens: 10 });
      await service.recordUsage({
        actorRef: 'alice',
        feature: 'embeddings',
        modelId: null,
        inputTokens: 90_000,
        countsTowardsQuota: false,
      });
    } finally {
      unsubscribe(name, listener);
    }
    expect(store.governanceUsage().map((row) => row.modelId)).toEqual(['unknown', 'unknown']);
    expect(events[1]?.countsTowardsQuota).toBe(false);
    expect(events[0]?.countsTowardsQuota).toBeUndefined();
    expect((await store.quotaToday('alice', today())).usedTokens).toBe(10);
  });

  it('never throws into the caller unless throwOnError', async () => {
    const { service, store } = await boot();
    vi.spyOn(store, 'recordUsage').mockRejectedValue(new Error('database is down'));
    const result = await service.recordUsage({ actorRef: 'a', feature: 'tts', modelId: 'tts-1' });
    expect(result.recorded).toBe(false);
    await expect(
      service.recordUsage(
        { actorRef: 'a', feature: 'tts', modelId: 'tts-1' },
        { throwOnError: true },
      ),
    ).rejects.toThrow('database is down');
    await expect(
      service.recordUsage({ actorRef: 'a', feature: '', modelId: 'tts-1' }, { throwOnError: true }),
    ).rejects.toThrow(/feature/);
    for (const bad of [
      { actorRef: '   ', feature: 'f', modelId: 'm' },
      { actorRef: 'a', feature: 'f', modelId: 'm', requests: 0 },
    ]) {
      await expect(service.recordUsage(bad, { throwOnError: true })).rejects.toThrow(TypeError);
    }
  });
});
