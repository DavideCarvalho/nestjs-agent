import {
  type AgentStreamEvent,
  type RecordRunEndInput,
  decodeStreamEvent,
} from '@dudousxd/nestjs-agent-core';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
} from '@dudousxd/nestjs-agent-testing';
import { DurableModule, WorkflowService } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';
import { AgentDurableModule } from './agent-durable.module.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Module-level because the tool instance is built by Nest, not by the test. Re-armed per test in the
 * `beforeEach` below.
 */
let toolRunning = deferred();
let releaseTool = deferred();

/** A read tool that parks while it runs, so a cancel can land squarely mid-execution. */
@AiTool({ name: 'slow', kind: 'read', description: 'slow', input: z.object({}) })
@Injectable()
class SlowTool {
  async execute() {
    toolRunning.resolve();
    await releaseTool.promise;
    return { done: true };
  }
}

/** An action tool, so the turn parks on an approval that never arrives. */
@AiTool({ name: 'purge', kind: 'action', description: 'purge', input: z.object({}) })
@Injectable()
class PurgeTool {
  async execute() {
    return { purged: true };
  }
}

@Agent({ name: 'default', systemPrompt: 'cancellation test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

function callsThen(tool: string): FakeScript {
  return (_args, turnIndex) =>
    turnIndex === 0 ? { text: 'working', toolCall: { name: tool, input: {} } } : { text: 'done' };
}

async function buildApp(script: FakeScript) {
  const inner = new InMemoryAgentStore();
  const ends: RecordRunEndInput[] = [];
  const store = Object.assign(Object.create(inner) as InMemoryAgentStore, {
    recordRunEnd: async (end: RecordRunEndInput) => {
      ends.push(end);
      await inner.recordRunEnd(end);
    },
  });
  let modelCalls = 0;
  const scripted = new FakeModelProvider(script);
  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store: new InMemoryStateStore(),
        transport: new EventEmitterTransport(new EventEmitter2()),
      }),
      AgentModule.forRoot({
        model: {
          runTurn: async (args) => {
            modelCalls += 1;
            return scripted.runTurn(args);
          },
        },
        store,
        durable: true,
        defaultAgent: 'default',
        // The in-process localStep path: the whole turn runs in this process, which is the shape
        // where a cancel has to be OBSERVED rather than simply refused at a dispatch boundary.
        dispatchedSteps: false,
      }),
      AgentDurableModule,
    ],
    providers: [SlowTool, PurgeTool, DefaultAgent],
  }).compile();
  await moduleRef.init();
  return {
    moduleRef,
    store: inner,
    ends,
    service: moduleRef.get(AgentService),
    workflows: moduleRef.get(WorkflowService),
    engine: moduleRef.get(WorkflowEngine),
    modelCalls: () => modelCalls,
  };
}

async function drain(service: AgentService, runId: string) {
  const frames: AgentStreamEvent[] = [];
  let failure: unknown;
  try {
    for await (const chunk of service.subscribe(runId)) {
      for (const line of new TextDecoder().decode(chunk).split('\n')) {
        if (line.length > 0) {
          const event = decodeStreamEvent(line);
          if (event !== null) {
            frames.push(event);
          }
        }
      }
    }
  } catch (error) {
    failure = error;
  }
  return { frames, failure };
}

beforeEach(() => {
  toolRunning = deferred();
  releaseTool = deferred();
});

describe('the durable runner’s cancel', () => {
  it('stops a running turn, and records it cancelled rather than failed', async () => {
    const app = await buildApp(callsThen('slow'));
    try {
      const { runId } = await app.service.chat({ actor: ACTOR, message: 'hi' });
      const streamed = drain(app.service, runId);
      await toolRunning.promise;
      await app.service.cancel(ACTOR, runId);
      releaseTool.resolve();

      const result = await app.workflows.waitForRun(runId, { timeoutMs: 5000 });
      expect(result.status).toBe('cancelled');
      // The tool already executing finished; the turn stopped before its next model call.
      expect(app.modelCalls()).toBe(1);
      expect(app.ends).toEqual([{ runId, status: 'cancelled' }]);
      expect(app.store.governanceRuns()[0]).toMatchObject({ runId, status: 'cancelled' });

      const { frames, failure } = await streamed;
      // Ended, not failed: a client that retries a failed stream must not retry a user's Stop.
      expect(failure).toBeUndefined();
      expect(frames.at(-1)).toEqual({ kind: 'cancelled' });
    } finally {
      releaseTool.resolve();
      await app.moduleRef.close();
    }
  });

  it('releases the thread, so nothing reattaches to a stopped turn', async () => {
    const app = await buildApp(callsThen('slow'));
    try {
      const { runId, threadId } = await app.service.chat({ actor: ACTOR, message: 'hi' });
      void drain(app.service, runId);
      await toolRunning.promise;
      await app.service.cancel(ACTOR, runId);
      releaseTool.resolve();
      await app.workflows.waitForRun(runId, { timeoutMs: 5000 });
      expect(await app.store.activeRunForThread(threadId)).toBeNull();
    } finally {
      releaseTool.resolve();
      await app.moduleRef.close();
    }
  });

  it('stops a turn parked on a human, which no observation inside the body can reach', async () => {
    const app = await buildApp(callsThen('purge'));
    try {
      const { runId } = await app.service.chat({ actor: ACTOR, message: 'hi' });
      const streamed = drain(app.service, runId);
      // Let the turn reach its approval wait and suspend there.
      await app.engine.waitForRun(runId, { timeoutMs: 5000 });
      await app.service.cancel(ACTOR, runId);

      const result = await app.engine.waitForRun(runId, {
        timeoutMs: 5000,
        until: 'terminal',
      });
      expect(result.status).toBe('cancelled');
      // The approval never came and never will: the runtime's own cancel is what settles this one.
      expect(app.ends).toEqual([{ runId, status: 'cancelled' }]);
      const { frames, failure } = await streamed;
      expect(failure).toBeUndefined();
      expect(frames.at(-1)).toEqual({ kind: 'cancelled' });
    } finally {
      await app.moduleRef.close();
    }
  });

  it('refuses to let one actor stop another’s run', async () => {
    const app = await buildApp(callsThen('slow'));
    try {
      const { runId } = await app.service.chat({ actor: ACTOR, message: 'hi' });
      void drain(app.service, runId);
      await toolRunning.promise;
      await expect(app.service.cancel({ id: 'intruder', roles: [] }, runId)).rejects.toThrow(
        /another actor/,
      );
      expect(app.ends).toEqual([]);
    } finally {
      releaseTool.resolve();
      await app.moduleRef.close();
    }
  });
});
