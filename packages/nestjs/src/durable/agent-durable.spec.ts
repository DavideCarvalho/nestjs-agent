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
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';
import { AgentDurableModule } from './agent-durable.module.js';

@AiTool({
  name: 'purgeCache',
  kind: 'action',
  description: 'purge',
  input: z.object({ key: z.string() }),
})
@Injectable()
class PurgeCacheTool {
  async execute(input: { key: string }) {
    return { purged: input.key };
  }
}

/** A `read`-kind tool that always throws — exercises the `persist:toolfail` path. */
@AiTool({
  name: 'explode',
  kind: 'read',
  description: 'always throws',
  input: z.object({}),
})
@Injectable()
class FailingTool {
  async execute(): Promise<never> {
    throw new Error('tool exploded');
  }
}

@Agent({ name: 'default', systemPrompt: 'durable test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

/** `dispatchedSteps` defaults to `false` — set `true` to exercise the routed-remote-step path. */
async function buildDurableApp(script: FakeScript, dispatchedSteps = false) {
  const store = new InMemoryAgentStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      // Operator + worker in one process — an operator requires a transport since durable 0.31's
      // topology roles; the event-emitter transport keeps the whole run in-process for the test.
      DurableModule.forRoot({
        store: new InMemoryStateStore(),
        transport: new EventEmitterTransport(new EventEmitter2()),
      }),
      AgentModule.forRoot({
        model: new FakeModelProvider(script),
        store,
        durable: true,
        defaultAgent: 'default',
        ...(dispatchedSteps ? { dispatchedSteps: true } : {}),
      }),
      AgentDurableModule,
    ],
    providers: [PurgeCacheTool, FailingTool, DefaultAgent],
  }).compile();
  await moduleRef.init();
  return {
    moduleRef,
    store,
    service: moduleRef.get(AgentService),
    workflows: moduleRef.get(WorkflowService),
    // `WorkflowService.waitForRun`'s public type only exposes `timeoutMs`; the dispatchedSteps
    // tests below need the engine's own `until: 'terminal'` (see the comment at their first use).
    engine: moduleRef.get(WorkflowEngine),
  };
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of iterable) {
    out += decoder.decode(chunk);
  }
  return out;
}

describe('durable wiring', () => {
  it('throws a clear error when durable:true but AgentDurableModule is missing', async () => {
    const build = Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store: new InMemoryStateStore(),
          transport: new EventEmitterTransport(new EventEmitter2()),
        }),
        AgentModule.forRoot({
          model: new FakeModelProvider(() => ({ text: 'x' })),
          store: new InMemoryAgentStore(),
          durable: true,
          // AgentDurableModule intentionally NOT imported
        }),
      ],
    }).compile();
    await expect(build).rejects.toThrow(/requires importing AgentDurableModule/);
  });
});

describe('AgentDurableModule (the agent turn as a durable workflow)', () => {
  it('runs a no-tool turn as a durable run and streams it', async () => {
    const { moduleRef, service, workflows, store } = await buildDurableApp(() => ({
      text: 'hello durable',
    }));
    try {
      const { runId } = await service.chat({
        actor: { id: 'u1', roles: ['ADMIN'] },
        message: 'hi',
      });
      const collected = collect(service.subscribe(runId));
      const result = await workflows.waitForRun(runId, { timeoutMs: 5000 });
      const streamed = await collected;

      expect(result.status).toBe('completed');
      expect(streamed).toContain('hello durable');
      const detail = await store.getThread((await store.listThreads('u1'))[0]?.id ?? '');
      expect(detail?.messages.map((m) => m.role)).toContain('assistant');
      // Core's loop records the run outcome (persist:run:start/end) — assert it lands through the
      // durable path too, so the reliability read-model sees durable runs.
      expect(store.governanceRuns()[0]).toMatchObject({ runId, status: 'completed' });
    } finally {
      await moduleRef.close();
    }
  });

  it('records a failed run end when the model provider throws', async () => {
    const { moduleRef, service, workflows, store } = await buildDurableApp(() => {
      throw new Error('model unavailable');
    });
    try {
      const { runId } = await service.chat({
        actor: { id: 'u1', roles: ['ADMIN'] },
        message: 'hi',
      });
      const result = await workflows.waitForRun(runId, { timeoutMs: 5000 });

      expect(result.status).toBe('failed');
      // The loop can't catch its own crash — the workflow's catch settles the persisted outcome.
      expect(store.governanceRuns()[0]).toMatchObject({
        runId,
        status: 'failed',
        errorCode: 'run_failed',
        errorMessage: 'model unavailable',
      });
    } finally {
      await moduleRef.close();
    }
  });

  it('suspends on an action tool (waitForSignal) and resumes on approve signal', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'about to purge', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
        : { text: 'purged durably' };
    const { moduleRef, service, workflows, store } = await buildDurableApp(script);
    try {
      const { runId } = await service.chat({
        actor: { id: 'u1', roles: ['ADMIN'] },
        message: 'purge it',
      });
      const collected = collect(service.subscribe(runId));

      await new Promise((resolve) => setTimeout(resolve, 50));
      await service.approve({ id: 'u1', roles: ['ADMIN'] }, 'call-0-purgeCache');

      const result = await workflows.waitForRun(runId, { timeoutMs: 5000 });
      const streamed = await collected;

      expect(result.status).toBe('completed');
      expect(streamed).toContain('purged durably');
      expect(store.toolCallRows()[0]).toMatchObject({ toolName: 'purgeCache', status: 'executed' });
    } finally {
      await moduleRef.close();
    }
  });
});

describe('AgentDurableModule with dispatchedSteps: true (llm/tool as routed remote steps)', () => {
  it('completes a no-tool turn via the dispatched llm step and streams it', async () => {
    const { moduleRef, service, engine, store } = await buildDurableApp(
      () => ({ text: 'hello dispatched' }),
      true,
    );
    try {
      const { runId } = await service.chat({
        actor: { id: 'u1', roles: ['ADMIN'] },
        message: 'hi',
      });
      const collected = collect(service.subscribe(runId));
      // `ctx.step` suspends the run between dispatch and the transport round-trip resolving it —
      // `WorkflowService.waitForRun`'s default (`until: 'settled'`) treats that momentary suspend
      // the same as a genuine HITL/timer wait and can return `'suspended'` before the dispatched
      // step's result actually lands. `until: 'terminal'` polls through every such hop instead.
      const result = await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
      const streamed = await collected;

      expect(result.status).toBe('completed');
      expect(streamed).toContain('hello dispatched');
      const detail = await store.getThread((await store.listThreads('u1'))[0]?.id ?? '');
      expect(detail?.messages.map((m) => m.role)).toContain('assistant');
    } finally {
      await moduleRef.close();
    }
  });

  // Exercises hooks.isControlFlowError: the dispatched tool step's first `ctx.step` dispatch throws
  // `WorkflowSuspended` through the loop's tool catch, which must rethrow it — not persist a bogus
  // toolfail checkpoint that would diverge from the replay's real result (NonDeterminismError).
  it('suspends on an action tool, approves, and completes with the tool run via the dispatched step', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'about to purge', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
        : { text: 'purged durably' };
    const { moduleRef, service, engine, store } = await buildDurableApp(script, true);
    try {
      const { runId } = await service.chat({
        actor: { id: 'u1', roles: ['ADMIN'] },
        message: 'purge it',
      });
      const collected = collect(service.subscribe(runId));

      await new Promise((resolve) => setTimeout(resolve, 50));
      await service.approve({ id: 'u1', roles: ['ADMIN'] }, 'call-0-purgeCache');

      const result = await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
      const streamed = await collected;

      expect(result.status).toBe('completed');
      expect(streamed).toContain('purged durably');
      expect(store.toolCallRows()[0]).toMatchObject({ toolName: 'purgeCache', status: 'executed' });
    } finally {
      await moduleRef.close();
    }
  });

  it('persists a throwing tool call as failed via the dispatched step and still completes the run', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'about to explode', toolCall: { name: 'explode', input: {} } }
        : { text: 'handled the failure' };
    const { moduleRef, service, engine, store } = await buildDurableApp(script, true);
    try {
      const { runId } = await service.chat({
        actor: { id: 'u1', roles: ['ADMIN'] },
        message: 'explode it',
      });
      const collected = collect(service.subscribe(runId));
      const result = await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
      const streamed = await collected;

      expect(result.status).toBe('completed');
      expect(store.toolCallRows()[0]).toMatchObject({ toolName: 'explode', status: 'failed' });
      // The REAL tool error must be what's recorded — not the dispatch's own WorkflowSuspended
      // signal (which isControlFlowError lets escape the tool catch instead of being persisted).
      // The tool-output-error stream frame carries the same message string persist:toolfail writes.
      expect(streamed).toContain('tool exploded');
      expect(streamed).not.toContain('workflow suspended');
    } finally {
      await moduleRef.close();
    }
  });

  it('rejects at build when dispatchedSteps:true is set without durable:true', () => {
    expect(() =>
      AgentModule.forRoot({
        model: new FakeModelProvider(() => ({ text: 'x' })),
        store: new InMemoryAgentStore(),
        dispatchedSteps: true,
        // durable intentionally omitted (defaults to false)
      }),
    ).toThrow(/requires durable: true/);
  });
});
