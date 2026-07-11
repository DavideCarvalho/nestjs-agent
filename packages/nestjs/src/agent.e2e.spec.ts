import type {
  AgentApprovalPort,
  AgentPricingStore,
  AgentStore,
  AppendMessageInput,
  CreateThreadInput,
  QuotaStore,
  RecordToolCallInput,
  RecordUsageInput,
  Retriever,
  RolesPolicy,
  StoredMessage,
  ThreadDetail,
  ThreadSummary,
  UpdateToolCallInput,
} from '@dudousxd/nestjs-agent-core';
import { AGENT_APPROVAL_PORT, AGENT_PRICING_STORE } from '@dudousxd/nestjs-agent-core';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryPricingStore,
  InMemoryQuotaStore,
} from '@dudousxd/nestjs-agent-testing';
import {
  type DynamicModule,
  ForbiddenException,
  Global,
  Injectable,
  Module,
  NotFoundException,
  type Type,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from './agent.module.js';
import { AgentService } from './agent.service.js';
import { Agent } from './decorator/agent.decorator.js';
import { AiTool } from './decorator/ai-tool.decorator.js';
import { HeaderActorResolver } from './resolver/header-actor-resolver.js';

/**
 * `AGENT_PRICING_STORE` is bound externally (like a real host's store module would) — see the usage
 * site below for why a plain sibling provider on the root TestingModule isn't visible to AgentModule.
 */
function globalPricingStoreModule(pricingStore: AgentPricingStore): DynamicModule {
  @Global()
  @Module({
    providers: [{ provide: AGENT_PRICING_STORE, useValue: pricingStore }],
    exports: [AGENT_PRICING_STORE],
  })
  class GlobalPricingStoreModule {}
  return { module: GlobalPricingStoreModule };
}

/**
 * An `AgentStore` that delegates everything to an in-memory store EXCEPT `updateThread` and
 * `activeRunForThread` — both left undefined (they're optional on the SPI) to exercise the "store
 * predates this feature" paths: `PATCH /threads/:id` 501s on a `defaultAgent` change, and thread
 * reads normalize `activeRunId` to `null` rather than throwing or leaving it absent.
 */
class MinimalAgentStore implements AgentStore {
  private readonly inner = new InMemoryAgentStore();

  createThread(input: CreateThreadInput): Promise<ThreadSummary> {
    return this.inner.createThread(input);
  }
  getThread(threadId: string): Promise<ThreadDetail | null> {
    return this.inner.getThread(threadId);
  }
  listThreads(actorRef: string, limit?: number): Promise<ThreadSummary[]> {
    return this.inner.listThreads(actorRef, limit);
  }
  softDeleteThread(threadId: string): Promise<void> {
    return this.inner.softDeleteThread(threadId);
  }
  forkThread(threadId: string, fromMessageId: string): Promise<ThreadSummary> {
    return this.inner.forkThread(threadId, fromMessageId);
  }
  setTitle(threadId: string, title: string): Promise<void> {
    return this.inner.setTitle(threadId, title);
  }
  promoteThread(threadId: string): Promise<void> {
    return this.inner.promoteThread(threadId);
  }
  setActiveStream(threadId: string, runId: string | null): Promise<void> {
    return this.inner.setActiveStream(threadId, runId);
  }
  ownerOfThread(threadId: string): Promise<string | null> {
    return this.inner.ownerOfThread(threadId);
  }
  ownerOfToolCall(toolCallId: string): Promise<string | null> {
    return this.inner.ownerOfToolCall(toolCallId);
  }
  runForToolCall(toolCallId: string): Promise<string | null> {
    return this.inner.runForToolCall(toolCallId);
  }
  ownerOfActiveStream(runId: string): Promise<string | null> {
    return this.inner.ownerOfActiveStream(runId);
  }
  appendMessage(input: AppendMessageInput): Promise<StoredMessage> {
    return this.inner.appendMessage(input);
  }
  truncateFrom(threadId: string, messageId: string): Promise<void> {
    return this.inner.truncateFrom(threadId, messageId);
  }
  recordToolCall(input: RecordToolCallInput): Promise<void> {
    return this.inner.recordToolCall(input);
  }
  updateToolCall(input: UpdateToolCallInput): Promise<void> {
    return this.inner.updateToolCall(input);
  }
  recordUsage(input: RecordUsageInput): Promise<void> {
    return this.inner.recordUsage(input);
  }
  quotaToday(actorRef: string, day: string): Promise<{ usedTokens: number; costUsd: number }> {
    return this.inner.quotaToday(actorRef, day);
  }
}

@AiTool({
  name: 'getWeather',
  kind: 'read',
  description: 'weather',
  input: z.object({ city: z.string() }),
})
@Injectable()
class GetWeatherTool {
  async execute(input: { city: string }) {
    return { tempC: 21, city: input.city };
  }
}

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

@AiTool({
  name: 'abilityTool',
  kind: 'read',
  description: 'ability-gated',
  input: z.object({}),
  ability: 'cache.purge',
})
@Injectable()
class AbilityTool {
  async execute() {
    return { ok: true };
  }
}

@AiTool({
  name: 'slowTool',
  kind: 'read',
  description: 'never resolves in time',
  input: z.object({}),
})
@Injectable()
class SlowTool {
  async execute(): Promise<{ done: boolean }> {
    // Far longer than any test's toolTimeoutMs, but short enough not to linger past the run.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return { done: true };
  }
}

/**
 * The default agent every test app registers under the name `'default'` (mirrors the old
 * `defaultAgent: { modelId, systemPrompt }` inline object, now expressed as an `@Agent` provider).
 */
@Agent({ name: 'default', systemPrompt: 'test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

interface BuildOptions {
  rolesPolicy?: RolesPolicy;
  /** Extra `@Agent`-decorated provider classes to register (e.g. an orchestrator + its sub-agents). */
  agents?: Type<object>[];
  path?: string;
  quota?: QuotaStore;
  toolTimeoutMs?: number;
  followUps?: boolean | { count: number };
  retrieval?: { mode: 'inject'; retriever: Retriever; topK?: number };
}

async function buildApp(script: FakeScript, options: BuildOptions = {}) {
  const store = new InMemoryAgentStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(script),
        store,
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'default',
        ...(options.path !== undefined ? { path: options.path } : {}),
        ...(options.rolesPolicy !== undefined ? { rolesPolicy: options.rolesPolicy } : {}),
        ...(options.quota !== undefined ? { quota: options.quota } : {}),
        ...(options.toolTimeoutMs !== undefined ? { toolTimeoutMs: options.toolTimeoutMs } : {}),
        ...(options.followUps !== undefined ? { followUps: options.followUps } : {}),
        ...(options.retrieval !== undefined ? { retrieval: options.retrieval } : {}),
      }),
    ],
    providers: [
      GetWeatherTool,
      PurgeCacheTool,
      AbilityTool,
      SlowTool,
      DefaultAgent,
      ...(options.agents ?? []),
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  await app.init();
  return { app, store, service: app.get(AgentService) };
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of iterable) {
    out += decoder.decode(chunk);
  }
  return out;
}

describe('AgentModule (inline)', () => {
  let app: NestExpressApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('streams a no-tool turn over SSE', async () => {
    const built = await buildApp(() => ({ text: 'hello over http' }));
    app = built.app;
    const res = await request(app.getHttpServer())
      .post('/agent/chat')
      .set('x-actor-id', 'u1')
      .set('x-actor-role', 'ADMIN')
      .send({ message: 'hi' });
    expect(res.status).toBe(201);
    expect(res.text).toContain('hello over http');
    expect(res.text).toContain('event: done');
  });

  it('refuses a request whose actor cannot be resolved (no x-actor-id)', async () => {
    const built = await buildApp(() => ({ text: 'never reached' }));
    app = built.app;
    const res = await request(app.getHttpServer()).post('/agent/chat').send({ message: 'hi' });
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('never reached');
    // nothing was persisted for a caller the resolver refused to identify
    expect(built.store.toolCallRows()).toHaveLength(0);
  });

  it('mounts the controllers under a configured route path', async () => {
    const built = await buildApp(() => ({ text: 'hi from /ai' }), { path: 'ai' });
    app = built.app;

    const mounted = await request(app.getHttpServer())
      .post('/ai/chat')
      .set('x-actor-id', 'u1')
      .set('x-actor-role', 'ADMIN')
      .send({ message: 'hi' });
    expect(mounted.status).toBe(201);
    expect(mounted.text).toContain('hi from /ai');

    // the default '/agent' prefix no longer exists
    const defaultPath = await request(app.getHttpServer())
      .post('/agent/chat')
      .set('x-actor-id', 'u1')
      .send({ message: 'hi' });
    expect(defaultPath.status).toBe(404);
  });

  it('auto-executes a read tool then answers', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'checking', toolCall: { name: 'getWeather', input: { city: 'Recife' } } }
        : { text: 'it is 21C' };
    const built = await buildApp(script);
    app = built.app;
    const { runId } = await built.service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'weather?',
    });
    const streamed = await collect(built.service.subscribe(runId));
    expect(streamed).toContain('it is 21C');
    expect(built.store.toolCallRows()[0]).toMatchObject({
      toolName: 'getWeather',
      status: 'executed',
    });
  });

  it('suspends an action tool until approved, then executes', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'about to purge', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
        : { text: 'purged ok' };
    const built = await buildApp(script);
    app = built.app;
    const { runId } = await built.service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'purge it',
    });

    const collected = collect(built.service.subscribe(runId));
    // give the loop a tick to reach the approval gate, then approve the (deterministic) tool id
    await new Promise((resolve) => setTimeout(resolve, 20));
    await built.service.approve({ id: 'u1', roles: ['ADMIN'] }, 'call-0-purgeCache');

    const streamed = await collected;
    expect(streamed).toContain('purged ok');
    expect(built.store.toolCallRows()[0]).toMatchObject({
      toolName: 'purgeCache',
      status: 'executed',
    });
  });

  it('binds AGENT_APPROVAL_PORT for the inline runner too — the console port resolves the same pending call', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'about to purge', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
        : { text: 'purged via port' };
    const built = await buildApp(script);
    app = built.app;
    const { runId } = await built.service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'purge it',
    });

    const collected = collect(built.service.subscribe(runId));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // No actor here at all — the port is authorized upstream (the dashboard's guards), not by
    // owning the thread, unlike `service.approve`/`reject` below.
    const port = app.get<AgentApprovalPort>(AGENT_APPROVAL_PORT);
    await port.approve('call-0-purgeCache');

    const streamed = await collected;
    expect(streamed).toContain('purged via port');
    expect(built.store.toolCallRows()[0]).toMatchObject({
      toolName: 'purgeCache',
      status: 'executed',
    });
  });

  it('refuses approve from an actor who does not own the tool call (403)', async () => {
    const built = await buildApp((_a, i) =>
      i === 0
        ? { text: 'purge', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
        : { text: 'ok' },
    );
    app = built.app;
    const { runId } = await built.service.chat({
      actor: { id: 'owner', roles: ['ADMIN'] },
      message: 'go',
    });
    void collect(built.service.subscribe(runId));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(
      built.service.approve({ id: 'intruder', roles: ['ADMIN'] }, 'call-0-purgeCache'),
    ).rejects.toThrow(ForbiddenException);
    // the owner can still approve their own run
    await built.service.approve({ id: 'owner', roles: ['ADMIN'] }, 'call-0-purgeCache');
  });

  it('scopes thread detail/delete to the owner (403 other, 404 missing)', async () => {
    const built = await buildApp(() => ({ text: 'hi' }));
    app = built.app;
    const { threadId } = await built.service.chat({
      actor: { id: 'owner', roles: ['ADMIN'] },
      message: 'hi',
    });
    await expect(built.service.getThread({ id: 'intruder' }, threadId)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(built.service.deleteThread({ id: 'intruder' }, threadId)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(built.service.getThread({ id: 'owner' }, 'no-such-thread')).rejects.toThrow(
      NotFoundException,
    );
    expect(await built.service.getThread({ id: 'owner' }, threadId)).not.toBeNull();
  });

  it('HTTP: GET /threads/:id of another actor is 403', async () => {
    const built = await buildApp(() => ({ text: 'hi' }));
    app = built.app;
    const { threadId } = await built.service.chat({
      actor: { id: 'owner', roles: ['ADMIN'] },
      message: 'hi',
    });
    const res = await request(app.getHttpServer())
      .get(`/agent/threads/${threadId}`)
      .set('x-actor-id', 'intruder')
      .set('x-actor-role', 'ADMIN');
    expect(res.status).toBe(403);
  });

  it('surfaces a quota-exceeded run as an event: error frame, not a done frame', async () => {
    const built = await buildApp(() => ({ text: 'should not run' }), {
      quota: new InMemoryQuotaStore(0),
    });
    app = built.app;
    const res = await request(app.getHttpServer())
      .post('/agent/chat')
      .set('x-actor-id', 'u1')
      .set('x-actor-role', 'ADMIN')
      .send({ message: 'hi' });
    expect(res.text).toContain('event: error');
    expect(res.text).toContain('quota_exceeded');
    expect(res.text).not.toContain('event: done');
  });

  it('does not bake defaultRoles into a tool spec (a custom policy sees undefined roles)', async () => {
    const seen: (string[] | undefined)[] = [];
    const rolesPolicy: RolesPolicy = {
      can: (_actor, tool) => {
        seen.push(tool.roles);
        return true;
      },
    };
    const built = await buildApp(
      (_a, i) =>
        i === 0
          ? { text: 'w', toolCall: { name: 'getWeather', input: { city: 'X' } } }
          : { text: 'done' },
      { rolesPolicy },
    );
    app = built.app;
    const { runId } = await built.service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'weather',
    });
    await collect(built.service.subscribe(runId));
    // None of the test tools declare `roles`, so the policy must always receive undefined —
    // the discovery layer no longer bakes the module's defaultRoles into every spec.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((roles) => roles === undefined)).toBe(true);
  });

  it('fails boot when an agent hands off to an @Agent that was never provided', async () => {
    // GhostAgent carries valid @Agent metadata (so the handoff is accepted at discovery time) but is
    // deliberately left out of `providers` — it's never instantiated, so it never registers into the
    // AgentRegistry. That dangling handoff must fail the boot, not silently resolve to an unrestricted
    // default agent.
    @Agent({ name: 'ghost-agent', systemPrompt: 'ghost' })
    @Injectable()
    class GhostAgent {}

    @Agent({ name: 'orchestrator', systemPrompt: 'orchestrator', handoff: [GhostAgent] })
    @Injectable()
    class OrchestratorAgent {}

    await expect(buildApp(() => ({ text: 'x' }), { agents: [OrchestratorAgent] })).rejects.toThrow(
      /not a registered @Agent/,
    );
  });

  it('scopes cancel to the run owner (403 other, 404 unknown run)', async () => {
    const built = await buildApp(() => ({ text: 'hi' }));
    app = built.app;
    const { runId } = await built.service.chat({
      actor: { id: 'owner', roles: ['ADMIN'] },
      message: 'hi',
    });
    await expect(built.service.cancel({ id: 'intruder' }, runId)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(built.service.cancel({ id: 'owner' }, 'no-such-run')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('regenerate re-runs the last exchange without appending a new user message', async () => {
    const built = await buildApp((_args, turnIndex) => ({ text: `answer-${turnIndex}` }));
    app = built.app;
    const first = await built.service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'question',
    });
    await collect(built.service.subscribe(first.runId));

    const again = await built.service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: '',
      threadId: first.threadId,
      regenerate: true,
    });
    await collect(built.service.subscribe(again.runId));

    const detail = await built.service.getThread({ id: 'u1' }, first.threadId);
    // Still exactly one user + one assistant — the assistant was replaced, not duplicated.
    expect(detail?.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(detail?.messages[0]?.content).toBe('question');
  });

  it('generates follow-up suggestions on the final message when enabled', async () => {
    const script: FakeScript = (args) =>
      args.system.includes('follow-up') ? { text: '["Q1?", "Q2?"]' } : { text: 'the answer' };
    const built = await buildApp(script, { followUps: { count: 2 } });
    app = built.app;
    const { runId, threadId } = await built.service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'hi',
    });
    await collect(built.service.subscribe(runId));
    const detail = await built.service.getThread({ id: 'u1' }, threadId);
    const assistant = detail?.messages.find((message) => message.role === 'assistant');
    expect(assistant?.followUps).toEqual(['Q1?', 'Q2?']);
    expect(assistant?.content).toBe('the answer');
  });

  it('records a tool that exceeds toolTimeoutMs as failed instead of hanging', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'calling', toolCall: { name: 'slowTool', input: {} } }
        : { text: 'gave up' };
    const built = await buildApp(script, { toolTimeoutMs: 30 });
    app = built.app;
    const { runId } = await built.service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'go',
    });
    await collect(built.service.subscribe(runId));
    const slow = built.store.toolCallRows().find((row) => row.toolName === 'slowTool');
    expect(slow?.status).toBe('failed');
  });

  it('orchestrator delegates to a sub-agent via a synthesized agent tool', async () => {
    const script: FakeScript = (args, turnIndex) => {
      const lastUser =
        [...args.messages]
          .reverse()
          .find((m) => m.role === 'user' && m.content)
          ?.content?.toLowerCase() ?? '';
      if (turnIndex === 0) {
        if (lastUser.includes('delegate')) {
          return {
            text: 'delegating',
            toolCall: { name: 'ask_sub', input: { task: 'weather please' } },
          };
        }
        if (lastUser.includes('weather')) {
          return { text: 'checking', toolCall: { name: 'getWeather', input: { city: 'Recife' } } };
        }
        return { text: 'no tool' };
      }
      const results = (args.messages.at(-1)?.toolResults ?? []).map((result) => result.output);
      return { text: `done: ${JSON.stringify(results)}` };
    };
    @Agent({ name: 'sub', systemPrompt: 'sub', tools: ['getWeather'] })
    @Injectable()
    class SubAgent {}

    @Agent({ name: 'orch', systemPrompt: 'orchestrator', handoff: [SubAgent] })
    @Injectable()
    class OrchAgent {}

    const built = await buildApp(script, { agents: [OrchAgent, SubAgent] });
    app = built.app;
    const { runId } = await built.service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'delegate this',
      agentName: 'orch',
    });
    const streamed = await collect(built.service.subscribe(runId));

    expect(streamed).toContain('done:');
    const rows = built.store.toolCallRows();
    // the sub-agent actually ran getWeather (on its own thread; the store is shared)
    expect(rows.some((row) => row.toolName === 'getWeather' && row.status === 'executed')).toBe(
      true,
    );
    // the orchestrator recorded the delegation as an `agent`-kind tool call
    expect(rows.some((row) => row.toolName === 'ask_sub')).toBe(true);
  });

  it('surfaces a sub-agent action tool to the human and approves it by tool-call id', async () => {
    const script: FakeScript = (args, turnIndex) => {
      const isSub = args.system.includes('sub-worker');
      if (isSub) {
        return turnIndex === 0
          ? { text: 'sub purging', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
          : { text: 'sub purged' };
      }
      return turnIndex === 0
        ? { text: 'delegating', toolCall: { name: 'ask_sub', input: { task: 'purge please' } } }
        : { text: 'orchestrator done' };
    };
    @Agent({ name: 'sub', systemPrompt: 'sub-worker', tools: ['purgeCache'] })
    @Injectable()
    class SubAgent {}

    @Agent({ name: 'orch', systemPrompt: 'orchestrator', handoff: [SubAgent] })
    @Injectable()
    class OrchAgent {}

    const built = await buildApp(script, { agents: [OrchAgent, SubAgent] });
    app = built.app;
    const { runId } = await built.service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'delegate this',
      agentName: 'orch',
    });
    // The sub-agent streams into the top-level run the human is watching.
    const collected = collect(built.service.subscribe(runId));
    // Let the orchestrator delegate and the sub-agent reach its approval gate.
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Approve by tool-call id alone: the server derives the sub-agent's own run (which the client
    // never sees) and routes the decision there — closing the sub-agent HITL loop.
    await built.service.approve({ id: 'u1', roles: ['ADMIN'] }, 'call-0-purgeCache');

    const streamed = await collected;
    // The sub-agent's output reached the human's stream (discovery)...
    expect(streamed).toContain('sub purging');
    // ...and the whole chain completed once its action was approved.
    expect(streamed).toContain('orchestrator done');
    const rows = built.store.toolCallRows();
    expect(rows.some((row) => row.toolName === 'purgeCache' && row.status === 'executed')).toBe(
      true,
    );
  });

  it('inject-mode RAG augments the prompt and records a synthetic retrieval tool call', async () => {
    const retriever: Retriever = {
      retrieve: async () => [
        { id: 'p1', text: 'The capital of France is Paris.', score: 0.9, source: 'geo/france' },
      ],
    };
    // The fake model echoes whether the retrieved context reached its system prompt.
    const script: FakeScript = (args) => ({
      text: args.system.includes('capital of France is Paris') ? 'grounded answer' : 'no context',
    });
    const built = await buildApp(script, { retrieval: { mode: 'inject', retriever } });
    app = built.app;
    const { runId } = await built.service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'what is the capital of france?',
    });

    const streamed = await collect(built.service.subscribe(runId));
    expect(streamed).toContain('grounded answer');
    // Retrieval persisted as a synthetic `retrieve` tool call (the citation surface), no schema change.
    expect(
      built.store
        .toolCallRows()
        .some((row) => row.toolName === 'retrieve' && row.status === 'executed'),
    ).toBe(true);
  });

  it("passes a tool's @AiTool ability through to the RolesPolicy", async () => {
    const seen: { name: string; ability?: string }[] = [];
    const recordingPolicy: RolesPolicy = {
      can: (_actor, tool) => {
        seen.push({
          name: tool.name,
          ...(tool.ability !== undefined ? { ability: tool.ability } : {}),
        });
        return true;
      },
    };
    const built = await buildApp(() => ({ text: 'noop' }), { rolesPolicy: recordingPolicy });
    app = built.app;
    const { runId } = await built.service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'hi',
    });
    await collect(built.service.subscribe(runId));

    expect(seen.find((tool) => tool.name === 'abilityTool')?.ability).toBe('cache.purge');
  });
});

describe('thread rename + defaultAgent (Feature 4)', () => {
  let app: NestExpressApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('PATCH sets title/defaultAgent; chat() precedence is explicit agentName > thread default > module default', async () => {
    @Agent({ name: 'specialist', systemPrompt: 'specialist agent', model: 'fake-1' })
    @Injectable()
    class SpecialistAgent {}

    const built = await buildApp(() => ({ text: 'answered' }), { agents: [SpecialistAgent] });
    app = built.app;
    const { threadId } = await built.service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'hi',
    });

    const patchRes = await request(app.getHttpServer())
      .patch(`/agent/threads/${threadId}`)
      .set('x-actor-id', 'u1')
      .set('x-actor-role', 'ADMIN')
      .send({ title: 'Renamed', defaultAgent: 'specialist' });
    expect(patchRes.status).toBe(200);

    const afterPatch = await built.service.getThread({ id: 'u1' }, threadId);
    expect(afterPatch?.title).toBe('Renamed');
    expect(afterPatch?.defaultAgent).toBe('specialist');

    // No explicit agentName on this send — the thread's own default takes over.
    const second = await built.service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'again',
      threadId,
    });
    await collect(built.service.subscribe(second.runId));
    const afterSecond = await built.service.getThread({ id: 'u1' }, threadId);
    expect(afterSecond?.messages.at(-1)?.agentName).toBe('specialist');

    // An explicit agentName still wins over the thread's own default.
    const third = await built.service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'once more',
      threadId,
      agentName: 'default',
    });
    await collect(built.service.subscribe(third.runId));
    const afterThird = await built.service.getThread({ id: 'u1' }, threadId);
    expect(afterThird?.messages.at(-1)?.agentName).toBe('default');
  });

  it('clearing defaultAgent (null) falls back to the module default again', async () => {
    @Agent({ name: 'specialist', systemPrompt: 'specialist agent', model: 'fake-1' })
    @Injectable()
    class SpecialistAgent {}
    const built = await buildApp(() => ({ text: 'answered' }), { agents: [SpecialistAgent] });
    app = built.app;
    const { threadId } = await built.service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'hi',
    });
    await built.service.updateThread({ id: 'u1', roles: ['ADMIN'] }, threadId, {
      defaultAgent: 'specialist',
    });
    await built.service.updateThread({ id: 'u1', roles: ['ADMIN'] }, threadId, {
      defaultAgent: null,
    });
    const detail = await built.service.getThread({ id: 'u1' }, threadId);
    expect(detail?.defaultAgent).toBeNull();

    const { runId } = await built.service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'again',
      threadId,
    });
    await collect(built.service.subscribe(runId));
    const after = await built.service.getThread({ id: 'u1' }, threadId);
    expect(after?.messages.at(-1)?.agentName).toBe('default');
  });

  it('501s a defaultAgent change against a store that lacks updateThread, but title-only patches still work', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AgentModule.forRoot({
          model: new FakeModelProvider(() => ({ text: 'hi' })),
          store: new MinimalAgentStore(),
          actorResolver: new HeaderActorResolver(),
          defaultAgent: 'default',
        }),
      ],
      providers: [DefaultAgent],
    }).compile();
    const testApp = moduleRef.createNestApplication<NestExpressApplication>();
    app = testApp;
    await testApp.init();
    const service = testApp.get(AgentService);
    const { threadId } = await service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'hi',
    });

    const res = await request(testApp.getHttpServer())
      .patch(`/agent/threads/${threadId}`)
      .set('x-actor-id', 'u1')
      .set('x-actor-role', 'ADMIN')
      .send({ defaultAgent: 'specialist' });
    expect(res.status).toBe(501);

    const titleRes = await request(testApp.getHttpServer())
      .patch(`/agent/threads/${threadId}`)
      .set('x-actor-id', 'u1')
      .set('x-actor-role', 'ADMIN')
      .send({ title: 'still works' });
    expect(titleRes.status).toBe(200);
  });
});

describe('activeRunId (Feature 5)', () => {
  let app: NestExpressApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('exposes the running runId on thread read while pending approval, then null after completion', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'about to purge', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
        : { text: 'purged ok' };
    const built = await buildApp(script);
    app = built.app;
    const { runId, threadId } = await built.service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'purge it',
    });
    const collected = collect(built.service.subscribe(runId));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const midRun = await built.service.getThread({ id: 'u1' }, threadId);
    expect(midRun?.activeRunId).toBe(runId);

    await built.service.approve({ id: 'u1', roles: ['ADMIN'] }, 'call-0-purgeCache');
    await collected;

    const afterRun = await built.service.getThread({ id: 'u1' }, threadId);
    expect(afterRun?.activeRunId).toBeNull();
  });

  it('reports null on a store that does not implement activeRunForThread', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AgentModule.forRoot({
          model: new FakeModelProvider(() => ({ text: 'hi' })),
          store: new MinimalAgentStore(),
          actorResolver: new HeaderActorResolver(),
          defaultAgent: 'default',
        }),
      ],
      providers: [DefaultAgent],
    }).compile();
    const testApp = moduleRef.createNestApplication<NestExpressApplication>();
    app = testApp;
    await testApp.init();
    const service = testApp.get(AgentService);
    const { threadId } = await service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'hi',
    });
    const detail = await service.getThread({ id: 'u1', roles: ['ADMIN'] }, threadId);
    expect(detail?.activeRunId).toBeNull();
  });
});

describe('per-message costUsd (Feature 3, wired through DI)', () => {
  let app: NestExpressApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('prices the stored assistant message when AGENT_PRICING_STORE is bound', async () => {
    const pricingStore = new InMemoryPricingStore();
    await pricingStore.upsertModelPrice({
      modelId: 'fake-1',
      inputPricePer1m: 3,
      outputPricePer1m: 15,
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        // AGENT_PRICING_STORE is bound externally (like a real host's store module would) — a
        // provider on the root TestingModule's own `providers` isn't visible to AgentDepsFactory,
        // which lives inside the separately-encapsulated AgentModule; only a @Global() module's
        // exports cross that boundary.
        globalPricingStoreModule(pricingStore),
        AgentModule.forRoot({
          model: new FakeModelProvider(() => ({ text: 'hi' })),
          store: new InMemoryAgentStore(),
          actorResolver: new HeaderActorResolver(),
          defaultAgent: 'default',
        }),
      ],
      providers: [DefaultAgent],
    }).compile();
    const testApp = moduleRef.createNestApplication<NestExpressApplication>();
    app = testApp;
    await testApp.init();
    const service = testApp.get(AgentService);
    const { runId, threadId } = await service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'hi',
    });
    await collect(service.subscribe(runId));

    const detail = await service.getThread({ id: 'u1' }, threadId);
    const assistant = detail?.messages.find((m) => m.role === 'assistant');
    expect(typeof assistant?.usage?.costUsd).toBe('number');
  });

  it('leaves costUsd null when no pricing store is bound', async () => {
    const built = await buildApp(() => ({ text: 'hi' }));
    app = built.app;
    const { runId, threadId } = await built.service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'hi',
    });
    await collect(built.service.subscribe(runId));
    const detail = await built.service.getThread({ id: 'u1' }, threadId);
    const assistant = detail?.messages.find((m) => m.role === 'assistant');
    expect(assistant?.usage?.costUsd).toBeNull();
  });
});
