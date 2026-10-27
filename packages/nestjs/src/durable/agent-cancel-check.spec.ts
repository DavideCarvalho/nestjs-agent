import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore } from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentModule } from '../agent.module.js';
import { Agent } from '../decorator/agent.decorator.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';
import { AgentDurableModule } from './agent-durable.module.js';
import { AgentRunWorkflow } from './agent-run.workflow.js';

@Agent({ name: 'default', systemPrompt: 'cancel check agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

/**
 * The loop asks whether its run was cancelled twice a step. The answer is the run's status, so it is
 * read from the run's own row where the gateway can read that alone: a run's detail carries every
 * checkpoint it wrote, and an agent turn's checkpoints hold its whole prompt once per model step.
 */
describe('the cancel check', () => {
  const opened: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    while (opened.length) await opened.pop()?.close();
  });

  async function workflow(): Promise<AgentRunWorkflow> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store: new InMemoryStateStore(),
          transport: new EventEmitterTransport(new EventEmitter2()),
        }),
        AgentModule.forRoot({
          model: new FakeModelProvider(() => ({ text: 'x' })),
          store: new InMemoryAgentStore(),
          actorResolver: new HeaderActorResolver(),
          durable: true,
          defaultAgent: 'default',
        }),
        AgentDurableModule,
      ],
      providers: [DefaultAgent],
    }).compile();
    await moduleRef.init();
    opened.push(moduleRef);
    return moduleRef.get(AgentRunWorkflow);
  }

  const asked = (wf: AgentRunWorkflow, runId: string): Promise<boolean> =>
    (wf as unknown as { isCancelled(runId: string): Promise<boolean> }).isCancelled(runId);
  const useGateway = (wf: AgentRunWorkflow, gateway: object) => {
    (wf as unknown as { runs: object }).runs = gateway;
  };

  it('reads the run row, not the run detail, when the gateway reads rows', async () => {
    const wf = await workflow();
    const getRunDetail = vi.fn(async () => null);
    const getRun = vi.fn(async () => ({ status: 'cancelling' }));
    useGateway(wf, { getRun, getRunDetail });

    expect(await asked(wf, 'run-1')).toBe(true);
    expect(getRun).toHaveBeenCalledWith('run-1');
    expect(getRunDetail).not.toHaveBeenCalled();
  });

  it('reads a running run as not cancelled from its row', async () => {
    const wf = await workflow();
    useGateway(wf, {
      getRun: async () => ({ status: 'running' }),
      getRunDetail: vi.fn(async () => null),
    });
    expect(await asked(wf, 'run-1')).toBe(false);
  });

  it('falls back to the run detail on a gateway that cannot read a row', async () => {
    const wf = await workflow();
    const getRunDetail = vi.fn(async () => ({ run: { status: 'cancelled' }, timeline: [] }));
    useGateway(wf, { getRunDetail });
    expect(await asked(wf, 'run-1')).toBe(true);
    expect(getRunDetail).toHaveBeenCalledWith('run-1');
  });

  it('answers no when the read fails', async () => {
    const wf = await workflow();
    useGateway(wf, {
      getRun: async () => {
        throw new Error('unreachable');
      },
      getRunDetail: vi.fn(),
    });
    expect(await asked(wf, 'run-1')).toBe(false);
  });
});
