import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { Suspend } from '@dudousxd/durable-worker';
import {
  AGENT_APPROVAL_PORT,
  AGENT_SPAN_EVENTS,
  type AgentApprovalPort,
  type AgentLoopResult,
  type AgentRunInput,
} from '@dudousxd/nestjs-agent-core';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
} from '@dudousxd/nestjs-agent-testing';
import { DurableModule, WorkflowService } from '@dudousxd/nestjs-durable';
import {
  InMemoryStateStore,
  type WorkflowCtx,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentModule } from '../agent.module.js';
import type { AgentModuleOptions } from '../agent.options.js';
import { AgentService } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';
import { AgentDurableModule } from './agent-durable.module.js';
import { AgentRunWorkflow } from './agent-run.workflow.js';

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
 * Throws a classified-transient (deadlock) error on its first invocation, then succeeds — exercises
 * `invokeWithTransientRetry` at the dispatched (`AgentRunSteps.tool`) execution site. A plain
 * `@Injectable()` field as the attempt counter: Nest gives each test's own `moduleRef` a fresh
 * instance, so there's no cross-test leakage.
 */
@AiTool({
  name: 'flakyDeadlock',
  kind: 'read',
  description: 'throws a deadlock once, then succeeds',
  input: z.object({}),
})
@Injectable()
class FlakyDeadlockTool {
  attempts = 0;
  async execute(): Promise<{ recovered: boolean; attempts: number }> {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new Error('Deadlock found when trying to get lock; try restarting transaction');
    }
    return { recovered: true, attempts: this.attempts };
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
 * The `agent.run` body as a release that ran the two long steps in-process journaled it:
 * `ctx.patched('agent:dispatched-steps')` answers `false` without consuming a position, which is
 * what the real `ctx.patched` answers on every replay of such a run. It is the only way left to
 * produce that journal, and so the only shape in which the loop's own `hooks.step` still runs the
 * model call and a tool invocation.
 */
@Injectable()
class InProcessJournalWorkflow extends AgentRunWorkflow {
  override run(ctx: WorkflowCtx, input: AgentRunInput): Promise<AgentLoopResult> {
    const legacy: WorkflowCtx = {
      ...ctx,
      patched: (id) => (id === 'agent:dispatched-steps' ? Promise.resolve(false) : ctx.patched(id)),
    };
    return super.run(legacy, input);
  }
}

async function buildDurableApp(
  script: FakeScript,
  options?: {
    toolTransientRetry?: AgentModuleOptions['toolTransientRetry'];
    /** Register the body above, so the turn journals — and runs — on the in-process names. */
    journalPredatingDispatch?: boolean;
  },
) {
  const toolTransientRetry = options?.toolTransientRetry;
  const store = new InMemoryAgentStore();
  const builder = Test.createTestingModule({
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
        actorResolver: new HeaderActorResolver(),
        durable: true,
        defaultAgent: 'default',
        ...(toolTransientRetry !== undefined ? { toolTransientRetry } : {}),
      }),
      AgentDurableModule,
    ],
    providers: [
      PurgeCacheTool,
      FailingTool,
      ThinWorkerSuspendTool,
      FlakyDeadlockTool,
      DefaultAgent,
    ],
  });
  const moduleRef = await (options?.journalPredatingDispatch === true
    ? builder.overrideProvider(AgentRunWorkflow).useClass(InProcessJournalWorkflow)
    : builder
  ).compile();
  await moduleRef.init();
  return {
    moduleRef,
    store,
    service: moduleRef.get(AgentService),
    workflows: moduleRef.get(WorkflowService),
    // `WorkflowService.waitForRun`'s public type only exposes `timeoutMs`; a dispatched turn needs
    // the engine's own `until: 'terminal'` (see the comment at its first use below).
    engine: moduleRef.get(WorkflowEngine),
  };
}

/**
 * Wait until the turn has parked its action tool on a human, which is what makes it approvable. The
 * ROW, not the run: a dispatched turn suspends at every transport hop, so the run's own status
 * cannot say whether the call has reached a human yet.
 */
async function pendingApproval(store: InMemoryAgentStore): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (store.toolCallRows()[0]?.status === 'pending_approval') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the turn never parked its action tool on an approval');
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
          actorResolver: new HeaderActorResolver(),
          durable: true,
          // AgentDurableModule intentionally NOT imported
        }),
      ],
    }).compile();
    await expect(build).rejects.toThrow(/requires importing AgentDurableModule/);
  });
});

// Every app here registers `InProcessJournalWorkflow`, so the turn runs and journals the way a run
// recorded before dispatch was the primitive does — the shape such a run must still be able to
// finish on, months after the release that wrote it. The dispatched path, which every FRESH run
// takes, is covered further down.
describe('AgentDurableModule (a turn whose journal predates dispatch)', () => {
  it('runs a no-tool turn as a durable run and streams it', async () => {
    const { moduleRef, service, workflows, store } = await buildDurableApp(
      () => ({ text: 'hello durable' }),
      { journalPredatingDispatch: true },
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
    const { moduleRef, service, workflows, store } = await buildDurableApp(
      () => {
        throw new Error('model unavailable');
      },
      { journalPredatingDispatch: true },
    );
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
    const { moduleRef, service, workflows, store } = await buildDurableApp(script, {
      journalPredatingDispatch: true,
    });
    try {
      const { runId } = await service.chat({
        actor: { id: 'u1', roles: ['ADMIN'] },
        message: 'purge it',
      });
      const collected = collect(service.subscribe(runId));

      await pendingApproval(store);
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
    const { moduleRef, service, engine, store } = await buildDurableApp(script);
    try {
      const { runId } = await service.chat({
        actor: { id: 'u1', roles: ['ADMIN'] },
        message: 'purge it',
      });
      const collected = collect(service.subscribe(runId));
      await pendingApproval(store);

      // The port never sees (or needs) the run's own actor — a console operator is authorized by
      // the dashboard's guards, not by owning the thread. `store.toolCallRows()` (a test helper)
      // doesn't surface `executedByRef` — spy on the SPI method to assert the decider ref lands.
      const updateSpy = vi.spyOn(store, 'updateToolCall');
      const port = moduleRef.get<AgentApprovalPort>(AGENT_APPROVAL_PORT);
      await port.approve('call-0-purgeCache', { executedByRef: 'console-admin' });

      const result = await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
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
    const { moduleRef, service, engine, store } = await buildDurableApp(script);
    try {
      const { runId } = await service.chat({
        actor: { id: 'u1', roles: ['ADMIN'] },
        message: 'purge it',
      });
      const collected = collect(service.subscribe(runId));
      await pendingApproval(store);

      // `store.toolCallRows()` (a test helper) doesn't surface `error`/`executedByRef` — spy on the
      // SPI method directly to assert both reach persistence, not just that the run unblocks.
      const updateSpy = vi.spyOn(store, 'updateToolCall');
      const port = moduleRef.get<AgentApprovalPort>(AGENT_APPROVAL_PORT);
      await port.reject('call-0-purgeCache', { executedByRef: 'console-admin', reason: 'not now' });

      const result = await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
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

describe('cross-runtime control-flow signals (thin-worker Suspend)', () => {
  // On the in-process journal shape deliberately: a tool that throws the raw signal only reaches
  // the loop's own tool catch when the tool runs in the body. Dispatch puts the same class in front
  // of the WORKFLOW's catch instead, from `ctx.step` — covered by the suite below.
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
    const { moduleRef, service, engine, store } = await buildDurableApp(script, {
      journalPredatingDispatch: true,
    });
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

describe('AgentDurableModule (llm/tool as the routed remote steps every turn dispatches)', () => {
  it('completes a no-tool turn via the dispatched llm step and streams it', async () => {
    const { moduleRef, service, engine, store } = await buildDurableApp(() => ({
      text: 'hello dispatched',
    }));
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
    const { moduleRef, service, engine, store } = await buildDurableApp(script);
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
    const { moduleRef, service, engine, store } = await buildDurableApp(script);
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

  // Exercises invokeWithTransientRetry at the DISPATCHED execution site (AgentRunSteps.tool): the
  // default `toolTransientRetry` policy (attempts: 2) retries the deadlock in place — same step,
  // no new checkpoint — so the tool call ends up 'executed', not 'failed'.
  it('retries a transient (deadlock) tool error via the dispatched step and completes the run', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'checking', toolCall: { name: 'flakyDeadlock', input: {} } }
        : { text: 'recovered from the deadlock' };
    const { moduleRef, service, engine, store } = await buildDurableApp(script);
    try {
      const { runId } = await service.chat({
        actor: { id: 'u1', roles: ['ADMIN'] },
        message: 'go',
      });
      const collected = collect(service.subscribe(runId));
      const result = await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
      const streamed = await collected;

      expect(result.status).toBe('completed');
      expect(streamed).toContain('recovered from the deadlock');
      expect(store.toolCallRows()[0]).toMatchObject({
        toolName: 'flakyDeadlock',
        status: 'executed',
      });
      expect(store.toolCallRows()[0]?.output).toEqual({ recovered: true, attempts: 2 });
    } finally {
      await moduleRef.close();
    }
  });

  // `toolTransientRetry: false` at the module level disables the retry entirely, even at the
  // dispatched site — the first (and only) attempt's deadlock surfaces as an ordinary tool failure.
  it('toolTransientRetry: false disables the dispatched retry — the deadlock fails the call outright', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'checking', toolCall: { name: 'flakyDeadlock', input: {} } }
        : { text: 'could not recover' };
    const { moduleRef, service, engine, store } = await buildDurableApp(script, {
      toolTransientRetry: false,
    });
    try {
      const { runId } = await service.chat({
        actor: { id: 'u1', roles: ['ADMIN'] },
        message: 'go',
      });
      const collected = collect(service.subscribe(runId));
      const result = await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
      const streamed = await collected;

      expect(result.status).toBe('completed');
      expect(store.toolCallRows()[0]).toMatchObject({
        toolName: 'flakyDeadlock',
        status: 'failed',
      });
      // The undisguised deadlock message streams as the tool's (one-shot) error — no retry happened.
      expect(streamed).toContain('Deadlock');
    } finally {
      await moduleRef.close();
    }
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
    const { moduleRef, service, engine } = await buildDurableApp(script);
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
