// Proves the actual point of `surface`: an http-only Nest app (no AgentRunSteps, no AgentRunWorkflow
// execution of its own) and an engine-only Nest app (no controllers) — TWO separate NestJS testing
// modules, mirroring two real pods — complete a chat turn TOGETHER over a shared durable store +
// transport, exactly the flip-style `APP_TYPE` split this option exists for.
//
// Wiring that makes the split actually run cross-process-like in a single test process:
// - ONE shared `InMemoryStateStore` (durable run/step state) and ONE shared `InMemoryAgentStore`
//   (threads/messages) — both sides read/write the same rows, like two pods sharing one database.
// - ONE shared `EventEmitter2` wrapped by a SEPARATE `EventEmitterTransport` per side — mirrors two
//   pods' clients talking to the same broker. durable's control-plane "enqueued" broadcast (see
//   `DurableModuleOptions.drive`'s doc) is what lets the http side's `drive: false` (enqueue-only)
//   `start()` get picked up and RUN by the engine side, with no polling delay.
// - ONE shared `InProcessTokenStreamSink` — the engine side writes tokens into it; the http side's
//   `AgentService.subscribe`/`.chat` reads from the SAME object, standing in for a real cross-process
//   sink (Redis pub/sub in production — see `AgentDurableModule`'s dispatchedSteps warning).
// - `@Agent`/`@AiTool` providers registered on BOTH sides (as a real flip-style feature module would
//   import identically into both its API and worker containers) — only the CONTROLLERS and the
//   durable workflow/step-handler REGISTRATION differ by surface.
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
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
import { DurableModule } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';
import { InProcessTokenStreamSink } from '../in-process-sink.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';
import { AgentDurableModule } from './agent-durable.module.js';
import { AgentRunSteps } from './agent-run.steps.js';

@Agent({ name: 'default', systemPrompt: 'cross-role test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

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

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of iterable) {
    out += decoder.decode(chunk);
  }
  return out;
}

interface CrossRolePair {
  httpModuleRef: TestingModule;
  engineModuleRef: TestingModule;
  httpService: AgentService;
  engineEngine: WorkflowEngine;
}

/**
 * Boots the http-side and engine-side Nest apps as two SEPARATE `TestingModule`s sharing one durable
 * store, one transport bus, one agent store, and one token sink — see the file header for why each
 * is shared. `drive: false` on the http side's `DurableModule` is the documented "enqueue-only API
 * pod" config (see the durable-setup skill); the engine side keeps the default `drive: true`.
 */
async function buildCrossRolePair(script: FakeScript): Promise<CrossRolePair> {
  const sharedStateStore = new InMemoryStateStore();
  const sharedAgentStore = new InMemoryAgentStore();
  const sharedSink = new InProcessTokenStreamSink();
  const sharedEmitter = new EventEmitter2();
  const model = new FakeModelProvider(script);

  const httpModuleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store: sharedStateStore,
        transport: new EventEmitterTransport(sharedEmitter),
        drive: false,
      }),
      AgentModule.forRoot({
        model,
        store: sharedAgentStore,
        sink: sharedSink,
        durable: true,
        surface: 'http',
        defaultAgent: 'default',
        actorResolver: new HeaderActorResolver(),
      }),
      AgentDurableModule.forRoot({ surface: 'http' }),
    ],
    providers: [DefaultAgent, PurgeCacheTool],
  }).compile();
  await httpModuleRef.init();

  const engineModuleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store: sharedStateStore,
        transport: new EventEmitterTransport(sharedEmitter),
      }),
      AgentModule.forRoot({
        model,
        store: sharedAgentStore,
        sink: sharedSink,
        durable: true,
        surface: 'engine',
        defaultAgent: 'default',
        actorResolver: new HeaderActorResolver(),
      }),
      AgentDurableModule.forRoot({ surface: 'engine' }),
    ],
    providers: [DefaultAgent, PurgeCacheTool],
  }).compile();
  await engineModuleRef.init();

  return {
    httpModuleRef,
    engineModuleRef,
    httpService: httpModuleRef.get(AgentService),
    engineEngine: engineModuleRef.get(WorkflowEngine),
  };
}

async function closePair(pair: CrossRolePair | undefined): Promise<void> {
  await pair?.httpModuleRef.close();
  await pair?.engineModuleRef.close();
}

let pair: CrossRolePair | undefined;

afterEach(async () => {
  await closePair(pair);
  pair = undefined;
});

describe('surface: http + engine — a chat turn runs across the two roles', () => {
  it('a no-tool turn started on the http side completes and streams from the engine side', async () => {
    pair = await buildCrossRolePair(() => ({ text: 'hello from the engine pod' }));
    const { httpService, engineEngine } = pair;

    const { runId } = await httpService.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'hi',
    });
    const collected = collect(httpService.subscribe(runId));
    // The run genuinely executes on the engine side (drive: true there, drive: false on http) —
    // `until: 'terminal'` polls the shared store through the control-plane hop, mirroring the
    // existing dispatched-steps suite's reasoning (agent-durable.spec.ts).
    const result = await engineEngine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
    const streamed = await collected;

    expect(result.status).toBe('completed');
    expect(streamed).toContain('hello from the engine pod');
  });

  it('the http side never registered AgentRunSteps — confirmed alongside the completed turn', async () => {
    pair = await buildCrossRolePair(() => ({ text: 'ok' }));
    const { httpService, engineEngine, httpModuleRef } = pair;
    const { runId } = await httpService.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'hi',
    });
    const result = await engineEngine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
    expect(result.status).toBe('completed');

    expect(() => httpModuleRef.get(AgentRunSteps)).toThrow();
  });
});

describe('surface: http + engine — HITL approve/reject from the http side', () => {
  it('approve from the http side resumes a run suspended on the engine side', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'about to purge', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
        : { text: 'purged durably' };
    pair = await buildCrossRolePair(script);
    const { httpService, engineEngine } = pair;

    const { runId } = await httpService.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'purge it',
    });
    const collected = collect(httpService.subscribe(runId));

    // Let the engine-side run reach its suspend (waiting on the action tool's approval) before the
    // http side approves — same settle-then-act pattern as the existing HITL suite.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await httpService.approve({ id: 'u1', roles: ['ADMIN'] }, 'call-0-purgeCache');

    const result = await engineEngine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
    const streamed = await collected;

    expect(result.status).toBe('completed');
    expect(streamed).toContain('purged durably');
  });

  it('reject from the http side resumes the run without executing the tool', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'about to purge', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
        : { text: 'not purging' };
    pair = await buildCrossRolePair(script);
    const { httpService, engineEngine } = pair;

    const { runId } = await httpService.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'purge it',
    });
    const collected = collect(httpService.subscribe(runId));

    await new Promise((resolve) => setTimeout(resolve, 100));
    await httpService.reject({ id: 'u1', roles: ['ADMIN'] }, 'call-0-purgeCache', 'not now');

    const result = await engineEngine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
    const streamed = await collected;

    expect(result.status).toBe('completed');
    expect(streamed).toContain('not purging');
  });

  it('the console AGENT_APPROVAL_PORT (bound on the http side) also reaches the engine-side run', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'about to purge', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
        : { text: 'purged durably' };
    pair = await buildCrossRolePair(script);
    const { httpModuleRef, httpService, engineEngine } = pair;

    const { runId } = await httpService.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'purge it',
    });
    const collected = collect(httpService.subscribe(runId));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const port = httpModuleRef.get<AgentApprovalPort>(AGENT_APPROVAL_PORT);
    await port.approve('call-0-purgeCache', { executedByRef: 'console-admin' });

    const result = await engineEngine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
    const streamed = await collected;

    expect(result.status).toBe('completed');
    expect(streamed).toContain('purged durably');
  });
});

/** Mirrors agent-durable.spec.ts's span-channel helper — proves the turn's llm/tool spans actually fired. */
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

interface SpanEnvelope {
  event: string;
  phase: string;
  traceId?: string;
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

describe('surface: http + engine — the dispatched steps genuinely execute (span proof)', () => {
  it('llm.turn and tool.execution spans fire for the cross-role turn', async () => {
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
    pair = await buildCrossRolePair(script);
    const { httpService, engineEngine } = pair;
    try {
      const { runId } = await httpService.chat({
        actor: { id: 'u1', roles: ['ADMIN'] },
        message: 'purge it',
      });
      const collected = collect(httpService.subscribe(runId));
      await new Promise((resolve) => setTimeout(resolve, 100));
      await httpService.approve({ id: 'u1', roles: ['ADMIN'] }, 'call-0-purgeCache');
      const result = await engineEngine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
      await collected;

      expect(result.status).toBe('completed');
      const starts = seen.filter((envelope) => envelope.phase === 'start');
      expect(starts.filter((envelope) => envelope.event === 'llm.turn').length).toBeGreaterThan(0);
      expect(starts.filter((envelope) => envelope.event === 'tool.execution').length).toBe(1);
      expect(seen.every((envelope) => envelope.traceId === runId)).toBe(true);
    } finally {
      for (const listener of listeners) {
        unsubscribe(listener.channel, listener.handler);
      }
    }
  });
});
