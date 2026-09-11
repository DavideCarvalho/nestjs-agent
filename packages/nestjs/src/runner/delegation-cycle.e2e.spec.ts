import type { FakeScript } from '@dudousxd/nestjs-agent-testing';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';

/**
 * Two agents that hand off to each other.
 *
 * The mutual edge is applied by CALLING the decorator once both classes exist, because a class
 * cannot name a class declared after it — so `@Agent({ handoff })` alone cannot express A↔B at all.
 * In a real deployment the same shape arrives through a circular import between two agent modules.
 */
@Agent({ name: 'beta', systemPrompt: 'beta agent' })
@Injectable()
class BetaAgent {}

@Agent({ name: 'alpha', systemPrompt: 'alpha agent', handoff: [BetaAgent] })
@Injectable()
class AlphaAgent {}

Agent({ name: 'beta', systemPrompt: 'beta agent', handoff: [AlphaAgent] })(BetaAgent);

/** Every turn delegates, so the chain only ever stops because the loop stops it. */
const alwaysDelegate: FakeScript = (args, turnIndex) => {
  const target = args.system.includes('alpha agent') ? 'ask_beta' : 'ask_alpha';
  if (turnIndex === 0) {
    return { text: 'passing it on', toolCall: { name: target, input: { task: 'keep going' } } };
  }
  const results = (args.messages.at(-1)?.toolResults ?? []).map((result) => result.output);
  return { text: `done: ${JSON.stringify(results)}` };
};

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of iterable) out += decoder.decode(chunk);
  return out;
}

async function buildApp() {
  const store = new InMemoryAgentStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(alwaysDelegate),
        store,
        actorResolver: new HeaderActorResolver(),
      }),
    ],
    providers: [AlphaAgent, BetaAgent],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, store, service: app.get(AgentService) };
}

describe('a mutual handoff, run for real', () => {
  it('is cut where the chain repeats, not after the depth ceiling', async () => {
    const built = await buildApp();
    const { runId } = await built.service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'go',
      agentName: 'alpha',
    });
    const streamed = await collect(built.service.subscribe(runId));

    // The guard is in the loop, but it can only see a cycle if the RUNNER hands the chain down.
    // Without that threading the loop reads an empty ancestry every hop, finds no repeat, and the
    // run walks to the depth ceiling instead — which is what this asserts against.
    expect(streamed).toContain('cycle');
    expect(streamed).not.toContain('depth limit');

    const delegations = built.store.toolCallRows().filter((row) => row.toolName.startsWith('ask_'));
    // alpha → beta-back → (refused). One hop each way, and the third is the repeat.
    expect(delegations).toHaveLength(2);

    await built.app.close();
  });
});
