// `AgentDurableModule.forRoot({ surface })` — the durable-side half of the AgentModule surface
// split. Proves via Nest's own module registry (`moduleRef.get`) which classes actually got
// instantiated as providers in each surface, since that IS what durable's DiscoveryService scans
// to decide what this process registers/subscribes (see `agent-durable.module.ts`'s doc). A full
// cross-role turn (proving the split actually EXECUTES correctly, not just registers) lives in
// `./agent-surface-cross-role.spec.ts`.
import { AGENT_DURABLE_RUNNER } from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore } from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentModule } from '../agent.module.js';
import { AgentDurableModule } from './agent-durable.module.js';
import { AgentRunSteps } from './agent-run.steps.js';
import { AgentRunWorkflow } from './agent-run.workflow.js';
import { DurableAgentRunner } from './durable-agent-runner.js';

function durableImport() {
  return DurableModule.forRoot({
    store: new InMemoryStateStore(),
    transport: new EventEmitterTransport(new EventEmitter2()),
  });
}

function agentImport(surface?: 'http' | 'engine' | 'both') {
  return AgentModule.forRoot({
    model: new FakeModelProvider(() => ({ text: 'x' })),
    store: new InMemoryAgentStore(),
    durable: true,
    ...(surface !== undefined ? { surface } : {}),
  });
}

let moduleRef: TestingModule | undefined;

afterEach(async () => {
  await moduleRef?.close();
  moduleRef = undefined;
});

describe('AgentDurableModule.forRoot() — default/omitted surface', () => {
  it("registers both AgentRunWorkflow and AgentRunSteps (today's full wiring)", async () => {
    moduleRef = await Test.createTestingModule({
      imports: [durableImport(), agentImport(), AgentDurableModule.forRoot()],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get(AgentRunWorkflow)).toBeInstanceOf(AgentRunWorkflow);
    expect(moduleRef.get(AgentRunSteps)).toBeInstanceOf(AgentRunSteps);
    expect(moduleRef.get(AGENT_DURABLE_RUNNER)).toBeInstanceOf(DurableAgentRunner);
  });
});

describe("AgentDurableModule bare class import (no forRoot() call) — stays 'both', unconditionally", () => {
  it('registers both AgentRunWorkflow and AgentRunSteps, identical to forRoot()', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [durableImport(), agentImport(), AgentDurableModule],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get(AgentRunWorkflow)).toBeInstanceOf(AgentRunWorkflow);
    expect(moduleRef.get(AgentRunSteps)).toBeInstanceOf(AgentRunSteps);
  });
});

describe("AgentDurableModule.forRoot({ surface: 'engine' })", () => {
  it('registers both AgentRunWorkflow and AgentRunSteps — identical to "both"', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        durableImport(),
        agentImport('engine'),
        AgentDurableModule.forRoot({ surface: 'engine' }),
      ],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get(AgentRunWorkflow)).toBeInstanceOf(AgentRunWorkflow);
    expect(moduleRef.get(AgentRunSteps)).toBeInstanceOf(AgentRunSteps);
  });
});

describe("AgentDurableModule.forRoot({ surface: 'http' })", () => {
  it('registers AgentRunWorkflow (so start() finds it) but NOT AgentRunSteps', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        durableImport(),
        agentImport('http'),
        AgentDurableModule.forRoot({ surface: 'http' }),
      ],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get(AgentRunWorkflow)).toBeInstanceOf(AgentRunWorkflow);
    // AgentRunSteps was never a provider in this container at all — Nest throws resolving it.
    expect(() => moduleRef?.get(AgentRunSteps)).toThrow();
  });

  it('still binds AGENT_DURABLE_RUNNER — AgentService.chat/approve and HITL signal delivery keep working', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        durableImport(),
        agentImport('http'),
        AgentDurableModule.forRoot({ surface: 'http' }),
      ],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get(AGENT_DURABLE_RUNNER)).toBeInstanceOf(DurableAgentRunner);
  });
});
