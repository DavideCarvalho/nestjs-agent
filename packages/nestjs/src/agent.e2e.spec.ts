import type { AgentDefinition, QuotaStore, RolesPolicy } from '@dudousxd/nestjs-agent-core';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryQuotaStore,
} from '@dudousxd/nestjs-agent-testing';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from './agent.module.js';
import { AgentService } from './agent.service.js';
import { AiTool } from './decorator/ai-tool.decorator.js';
import { HeaderActorResolver } from './resolver/header-actor-resolver.js';

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

interface BuildOptions {
  rolesPolicy?: RolesPolicy;
  features?: AgentDefinition[];
  path?: string;
  quota?: QuotaStore;
  toolTimeoutMs?: number;
  followUps?: boolean | { count: number };
}

async function buildApp(script: FakeScript, options: BuildOptions = {}) {
  const store = new InMemoryAgentStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(script),
        store,
        actorResolver: new HeaderActorResolver(),
        defaultAgent: { modelId: 'fake-1', systemPrompt: 'test agent' },
        ...(options.path !== undefined ? { path: options.path } : {}),
        ...(options.rolesPolicy !== undefined ? { rolesPolicy: options.rolesPolicy } : {}),
        ...(options.quota !== undefined ? { quota: options.quota } : {}),
        ...(options.toolTimeoutMs !== undefined ? { toolTimeoutMs: options.toolTimeoutMs } : {}),
        ...(options.followUps !== undefined ? { followUps: options.followUps } : {}),
      }),
      ...(options.features !== undefined ? [AgentModule.forFeature(options.features)] : []),
    ],
    providers: [GetWeatherTool, PurgeCacheTool, AbilityTool, SlowTool],
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
    await built.service.approve({ id: 'u1', roles: ['ADMIN'] }, runId, 'call-0-purgeCache');

    const streamed = await collected;
    expect(streamed).toContain('purged ok');
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
      built.service.approve({ id: 'intruder', roles: ['ADMIN'] }, runId, 'call-0-purgeCache'),
    ).rejects.toThrow(ForbiddenException);
    // the owner can still approve their own run
    await built.service.approve({ id: 'owner', roles: ['ADMIN'] }, runId, 'call-0-purgeCache');
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

  it('fails boot when an agent delegatesTo an unregistered agent', async () => {
    await expect(
      buildApp(() => ({ text: 'x' }), {
        features: [{ name: 'orchestrator', delegatesTo: ['ghost-agent'] }],
      }),
    ).rejects.toThrow(/not a registered agent/);
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
    const built = await buildApp(script, {
      features: [
        { name: 'orch', systemPrompt: 'orchestrator', delegatesTo: ['sub'] },
        { name: 'sub', systemPrompt: 'sub', tools: ['getWeather'] },
      ],
    });
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
