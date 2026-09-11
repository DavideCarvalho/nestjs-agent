import { AGENT_REGISTRY, type AgentRegistry } from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AgentModule } from '../agent.module.js';
import { Agent, type AgentOptions } from '../decorator/agent.decorator.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';

@Agent({ name: 'target' })
@Injectable()
class TargetAgent {}

/**
 * Every `@Agent` option, with a value distinguishable from a default.
 *
 * Typed `Required<AgentOptions>` on purpose: `definitionFrom` copies the options across one
 * hand-written spread per field, so an option added to the decorator and forgotten there is
 * accepted and discarded with nothing to fail. This fixture stops COMPILING the moment such an
 * option exists, which is earlier than any assertion could catch it.
 */
const EVERY_AGENT_OPTION: Required<AgentOptions> = {
  name: 'fully-specified',
  description: 'An agent with every option set.',
  systemPrompt: 'You are fully specified.',
  model: 'fake-7',
  maxSteps: 3,
  maxDelegationDepth: 9,
  maxAgentAppearances: 4,
  tools: ['getWeather'],
  handoff: [TargetAgent],
  history: { maxMessages: 4 },
  outputSchema: { '~standard': { version: 1, vendor: 'spec', validate: (v) => ({ value: v }) } },
  outputRepairAttempts: 2,
  intake: {
    questions: [
      {
        id: 'goal',
        prompt: 'What are we doing?',
        options: [{ value: 'refactor', label: 'Refactor' }],
        defaults: ['refactor'],
      },
    ],
    preamble: 'One question before I start.',
    when: 'thread-start',
  },
  ask: true,
};

@Agent(EVERY_AGENT_OPTION)
@Injectable()
class FullySpecifiedAgent {}

describe('@Agent options reaching the registered definition', () => {
  it('carries every option the decorator accepts', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AgentModule.forRoot({
          model: new FakeModelProvider(() => ({ text: 'answer' })),
          store: new InMemoryAgentStore(),
          actorResolver: new HeaderActorResolver(),
        }),
      ],
      providers: [TargetAgent, FullySpecifiedAgent],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    const definition = app.get<AgentRegistry>(AGENT_REGISTRY).get('fully-specified');

    expect(definition).toBeDefined();
    expect(definition).toMatchObject({
      name: 'fully-specified',
      description: 'An agent with every option set.',
      // `model` is the accounting label; the definition calls it `modelId`.
      modelId: 'fake-7',
      maxSteps: 3,
      maxDelegationDepth: 9,
      maxAgentAppearances: 4,
      tools: ['getWeather'],
      history: { maxMessages: 4 },
      outputRepairAttempts: 2,
      intake: {
        questions: [
          {
            id: 'goal',
            prompt: 'What are we doing?',
            options: [{ value: 'refactor', label: 'Refactor' }],
            defaults: ['refactor'],
          },
        ],
        preamble: 'One question before I start.',
        when: 'thread-start',
      },
      ask: true,
    });
    expect(definition?.systemPrompt).toBe('You are fully specified.');
    expect(definition?.outputSchema).toBeDefined();
    // `handoff` becomes delegation edges; a bare class resolves to the agent's name.
    expect(definition?.delegatesTo).toEqual(['target']);

    await app.close();
  });
});
