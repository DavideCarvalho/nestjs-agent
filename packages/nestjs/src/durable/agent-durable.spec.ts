import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { Suspend } from '@dudousxd/durable-worker';
import {
  AGENT_APPROVAL_PORT,
  AGENT_SPAN_EVENTS,
  type AgentApprovalPort,
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
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';
import { AgentDurableModule } from './agent-durable.module.js';
import { AGENT_DISPATCHED_STEPS } from './dispatched-steps.token.js';

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

/**
 * Simulates the BullMQ thin-worker runtime's dispatch suspend surfacing through the loop:
 * durable-worker's `Suspend` is a DIFFERENT class from durable-core's `WorkflowSuspended` (only the
 * `Symbol.for` control-flow marker is shared), so an instanceof-based catch misclassifies it.
 */
@AiTool({
  name: 'thinWorkerSuspend',
  kind: 'read',
  description: 'throws the thin-worker suspend signal',
  input: z.object({}),
})
@Injectable()
class ThinWorkerSuspendTool {
  async execute(): Promise<never> {
    throw new Suspend();
  }
}

@Agent({ name: 'default', systemPrompt: 'durable test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

/**
 * `dispatchedSteps` OMITTED (undefined) leaves the key off the options — exercising the durable
 * DEFAULT, which is dispatch ON. Pass an explicit `false` to pin the in-process localStep path, or
 * an explicit `true` to state the default outright (the dispatched suite below does, so its tests
 * keep meaning the same thing independent of what the default is).
 */
async function buildDurableApp(script: FakeScript, dispatchedSteps?: boolean) {
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
        ...(dispatchedSteps !== undefined ? { dispatchedSteps } : {}),
      }),
      AgentDurableModule,
    ],
    providers: [PurgeCacheTool, FailingTool, ThinWorkerSuspendTool, DefaultAgent],
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

// Explicit `dispatchedSteps: false` throughout — this suite pins the opt-out localStep path (the
// pre-default-on behavior). The dispatched path is the durable default, covered further down.
describe('AgentDurableModule (the agent turn as a durable workflow, dispatchedSteps: false)', () => {
  it('runs a no-tool turn as a durable run and streams it', async () => {
    const { moduleRef, service, workflows, store } = await buildDurableApp(
      () => ({ text: 'hello durable' }),
      false,
    );
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
    }, false);
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
    const { moduleRef, service, workflows, store } = await buildDurableApp(script, false);
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

describe('AGENT_APPROVAL_PORT (console HITL — no ownership re-check, same durable signal path)', () => {
  it('approve via the port resolves a durable pending action tool', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'about to purge', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
        : { text: 'purged durably' };
    // Pinned to the localStep path (`false`) — the port's mechanics are dispatch-agnostic and the
    // `workflows.waitForRun` settled-wait below is only reliable without dispatched-step suspends.
    const { moduleRef, service, workflows, store } = await buildDurableApp(script, false);
    try {
      const { runId } = await service.chat({
        actor: { id: 'u1', roles: ['ADMIN'] },
        message: 'purge it',
      });
      const collected = collect(service.subscribe(runId));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The port never sees (or needs) the run's own actor — a console operator is authorized by
      // the dashboard's guards, not by owning the thread. `store.toolCallRows()` (a test helper)
      // doesn't surface `executedByRef` — spy on the SPI method to assert the decider ref lands.
      const updateSpy = vi.spyOn(store, 'updateToolCall');
      const port = moduleRef.get<AgentApprovalPort>(AGENT_APPROVAL_PORT);
      await port.approve('call-0-purgeCache', { executedByRef: 'console-admin' });

      const result = await workflows.waitForRun(runId, { timeoutMs: 5000 });
      const streamed = await collected;

      expect(result.status).toBe('completed');
      expect(streamed).toContain('purged durably');
      expect(store.toolCallRows()[0]).toMatchObject({ toolName: 'purgeCache', status: 'executed' });
      // The console decider — not the run's own actor 'u1' — is recorded as the executor.
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCallId: 'call-0-purgeCache',
          status: 'executed',
          executedByRef: 'console-admin',
        }),
      );
    } finally {
      await moduleRef.close();
    }
  });

  it('reject via the port persists rejected with reason and the decider ref', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'about to purge', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
        : { text: 'not purging' };
    // Pinned to the localStep path (`false`) — the port's mechanics are dispatch-agnostic and the
    // `workflows.waitForRun` settled-wait below is only reliable without dispatched-step suspends.
    const { moduleRef, service, workflows, store } = await buildDurableApp(script, false);
    try {
      const { runId } = await service.chat({
        actor: { id: 'u1', roles: ['ADMIN'] },
        message: 'purge it',
      });
      const collected = collect(service.subscribe(runId));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // `store.toolCallRows()` (a test helper) doesn't surface `error`/`executedByRef` — spy on the
      // SPI method directly to assert both reach persistence, not just that the run unblocks.
      const updateSpy = vi.spyOn(store, 'updateToolCall');
      const port = moduleRef.get<AgentApprovalPort>(AGENT_APPROVAL_PORT);
      await port.reject('call-0-purgeCache', { executedByRef: 'console-admin', reason: 'not now' });

      const result = await workflows.waitForRun(runId, { timeoutMs: 5000 });
      await collected;

      expect(result.status).toBe('completed');
      expect(store.toolCallRows()[0]).toMatchObject({ toolName: 'purgeCache', status: 'rejected' });
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCallId: 'call-0-purgeCache',
          status: 'rejected',
          error: 'not now',
          executedByRef: 'console-admin',
        }),
      );
    } finally {
      await moduleRef.close();
    }
  });
});

describe('dispatchedSteps default (ON under durable: true)', () => {
  it('durable: true with NO dispatchedSteps key runs the turn via the dispatched path', async () => {
    // No second argument — the key is genuinely absent from the options.
    const { moduleRef, service, engine, store } = await buildDurableApp(() => ({
      text: 'hello default dispatch',
    }));
    try {
      expect(moduleRef.get<boolean>(AGENT_DISPATCHED_STEPS)).toBe(true);

      const { runId } = await service.chat({
        actor: { id: 'u1', roles: ['ADMIN'] },
        message: 'hi',
      });
      const collected = collect(service.subscribe(runId));
      // Dispatched `ctx.step`s momentarily suspend the run — `until: 'terminal'` polls through
      // those hops (see the dispatched suite below for the full explanation).
      const result = await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
      const streamed = await collected;

      expect(result.status).toBe('completed');
      expect(streamed).toContain('hello default dispatch');
      const detail = await store.getThread((await store.listThreads('u1'))[0]?.id ?? '');
      expect(detail?.messages.map((m) => m.role)).toContain('assistant');
    } finally {
      await moduleRef.close();
    }
  });

  it('dispatchedSteps: false opts back into in-process localSteps', async () => {
    const { moduleRef } = await buildDurableApp(() => ({ text: 'x' }), false);
    try {
      // The behavioral coverage of the localStep path is the first suite above (all pinned to
      // `false`); this just asserts the opt-out actually lands on the wiring flag.
      expect(moduleRef.get<boolean>(AGENT_DISPATCHED_STEPS)).toBe(false);
    } finally {
      await moduleRef.close();
    }
  });
});

describe('cross-runtime control-flow signals (thin-worker Suspend)', () => {
  // Regression for flip's live incident: on the BullMQ thin-worker runtime, dispatch suspends throw
  // durable-worker's `Suspend` — NOT durable-core's `WorkflowSuspended` — and the workflow's old
  // instanceof catch misclassified it as a real failure, running persist:run:fail + deactivate +
  // writer.fail DURING the suspend. The extra checkpoints corrupted the run's history, so the
  // resume died with NonDeterminismError. The marker predicate must rethrow it untouched.
  it('rethrows durable-worker Suspend untouched — no failure path runs mid-suspend', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'dispatching', toolCall: { name: 'thinWorkerSuspend', input: {} } }
        : { text: 'never reached' };
    const { moduleRef, service, engine, store } = await buildDurableApp(script, false);
    try {
      // Installed BEFORE the run so any failure-path write would be captured.
      const runEndSpy = vi.spyOn(store, 'recordRunEnd');
      const updateSpy = vi.spyOn(store, 'updateToolCall');

      const { runId } = await service.chat({
        actor: { id: 'u1', roles: ['ADMIN'] },
        message: 'go',
      });
      // This in-process harness engine does not own durable-worker's Suspend, so the run settles
      // however IT classifies the escaped signal — irrelevant here. The assertion target is the
      // WORKFLOW (and the loop's isControlFlowError hook): both must rethrow untouched.
      await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' }).catch(() => undefined);

      // No persist:run:fail — the workflow's catch recognized the signal as control flow...
      expect(runEndSpy).not.toHaveBeenCalled();
      // ...and no bogus persist:toolfail checkpoint — the loop's catch recognized it too.
      expect(updateSpy).not.toHaveBeenCalled();
      // The run row is still 'running': started, never settled by the agent's failure path.
      expect(store.governanceRuns()[0]).toMatchObject({ runId, status: 'running' });
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

/**
 * The five span sub-channels for one agent span event — mirrors diagnostics' `traceChannelNames`
 * (`aviary:<lib>:<event>` base + the five phase suffixes). Hand-built here because
 * `@dudousxd/nestjs-diagnostics` is core's dependency, not this package's, and the wire names ARE
 * the cross-package contract this test observes.
 */
function agentSpanChannels(event: string): string[] {
  const base = `aviary:agent:${event}`;
  return [
    `${base}:start`,
    `${base}:end`,
    `${base}:asyncStart`,
    `${base}:asyncEnd`,
    `${base}:error`,
  ];
}

/** The slice of diagnostics' span phase envelope the assertions below read. */
interface SpanEnvelope {
  event: string;
  phase: string;
  traceId?: string;
  payload?: Record<string, unknown>;
}

function isSpanEnvelope(message: unknown): message is SpanEnvelope {
  return (
    typeof message === 'object' &&
    message !== null &&
    'event' in message &&
    typeof message.event === 'string' &&
    'phase' in message &&
    typeof message.phase === 'string'
  );
}

describe('dispatched-step span emission (traceLlmTurn / traceToolExecution from the handlers)', () => {
  it('a dispatched turn emits llm.turn and tool.execution spans with traceId = runId', async () => {
    const seen: SpanEnvelope[] = [];
    const listeners: Array<{ channel: string; handler: (message: unknown) => void }> = [];
    for (const event of AGENT_SPAN_EVENTS) {
      for (const channel of agentSpanChannels(event)) {
        const handler = (message: unknown) => {
          if (isSpanEnvelope(message)) seen.push(message);
        };
        subscribe(channel, handler);
        listeners.push({ channel, handler });
      }
    }
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'about to purge', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
        : { text: 'purged durably' };
    const { moduleRef, service, engine } = await buildDurableApp(script, true);
    try {
      const { runId } = await service.chat({
        actor: { id: 'u1', roles: ['ADMIN'] },
        message: 'purge it',
      });
      const collected = collect(service.subscribe(runId));
      await new Promise((resolve) => setTimeout(resolve, 50));
      await service.approve({ id: 'u1', roles: ['ADMIN'] }, 'call-0-purgeCache');
      const result = await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
      await collected;
      expect(result.status).toBe('completed');

      const starts = seen.filter((envelope) => envelope.phase === 'start');
      // Two model calls (tool turn + final turn) served by the dispatched llm handler, each
      // carrying its threaded turn index...
      const llmStarts = starts.filter((envelope) => envelope.event === 'llm.turn');
      expect(llmStarts).toHaveLength(2);
      expect(llmStarts.map((envelope) => envelope.payload?.step)).toEqual([0, 1]);
      // ...and ONE tool execution served by the dispatched tool handler — genuine dispatch only:
      // the post-approval resume replays llm:0 from its checkpoint without re-emitting its span.
      const toolStarts = starts.filter((envelope) => envelope.event === 'tool.execution');
      expect(toolStarts).toHaveLength(1);
      expect(toolStarts[0]?.payload).toMatchObject({
        runId,
        toolCallId: 'call-0-purgeCache',
        toolName: 'purgeCache',
        toolType: 'action',
      });
      // Every phase envelope of every span correlates to the run.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((envelope) => envelope.traceId === runId)).toBe(true);
    } finally {
      for (const listener of listeners) {
        unsubscribe(listener.channel, listener.handler);
      }
      await moduleRef.close();
    }
  });
});
