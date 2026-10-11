import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AGENT_SERVICE, Agent, AgentModule, delegateToolName } from '@dudousxd/nestjs-agent';
import {
  AGENT_TOOL_REGISTRY,
  InMemoryPoppyStore,
  PERSONAL_AGENT_ROLE,
  type PoppyEvent,
  type ToolRegistry,
} from '@dudousxd/nestjs-agent-core';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
} from '@dudousxd/nestjs-agent-testing';
import { InMemoryStateStore } from '@dudousxd/nestjs-durable-core';
import { type DynamicModule, Injectable, type Type } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { PersonalAgentTurnService } from '../turn.js';
import type { PoppyPrincipal } from './auth.js';
import { PoppyConversations } from './conversations.js';

/**
 * The durable runtime — `@dudousxd/nestjs-durable`'s `DurableModule`, its in-process transport,
 * and the agent's `AgentDurableModule` — is `@dudousxd/nestjs-agent`'s dependency, not this
 * package's: load it from there, the same copies the agent's own durable runner imports.
 */
const nestjsPackage = fileURLToPath(new URL('../../../nestjs/package.json', import.meta.url));

/** The ESM entry of a package `@dudousxd/nestjs-agent` depends on. */
async function load<T>(name: string): Promise<T> {
  const manifest = realpathSync(join(dirname(nestjsPackage), 'node_modules', name, 'package.json'));
  const exported = (JSON.parse(readFileSync(manifest, 'utf8')) as { exports: unknown }).exports;
  const root = (exported as Record<string, unknown>)['.'] as Record<string, unknown>;
  const entry =
    (root.import as { default: string } | undefined)?.default ?? (root.default as string);
  return (await import(pathToFileURL(join(dirname(manifest), entry)).href)) as T;
}

interface DurableRuntime {
  DurableModule: { forRoot(options: { store: unknown; transport: unknown }): DynamicModule };
  EventEmitterTransport: new (emitter: unknown) => unknown;
  EventEmitter2: new () => unknown;
  AgentDurableModule: Type;
}

async function durableRuntime(): Promise<DurableRuntime> {
  const [durable, transport, events, agentDurable] = await Promise.all([
    load<{ DurableModule: DurableRuntime['DurableModule'] }>('@dudousxd/nestjs-durable'),
    load<{ EventEmitterTransport: DurableRuntime['EventEmitterTransport'] }>(
      '@dudousxd/nestjs-durable-transport-event-emitter',
    ),
    load<{ EventEmitter2: DurableRuntime['EventEmitter2'] }>('@nestjs/event-emitter'),
    import(pathToFileURL(join(dirname(nestjsPackage), 'src/durable/index.ts')).href) as Promise<{
      AgentDurableModule: Type;
    }>,
  ]);
  return {
    DurableModule: durable.DurableModule,
    EventEmitterTransport: transport.EventEmitterTransport,
    EventEmitter2: events.EventEmitter2,
    AgentDurableModule: agentDurable.AgentDurableModule,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const principal: PoppyPrincipal = {
  userId: 'u1',
  accountId: null,
  clientId: 'https://pa.example',
  scopes: [],
  sessionId: 's1',
  signedIn: false,
};

@Agent({ name: 'helper', systemPrompt: 'You are a helper.', tools: [] })
@Injectable()
class HelperAgent {}

@Agent({
  name: 'orchestrator',
  systemPrompt: 'You coordinate.',
  // The edge is opened to personal agents: a bare edge's delegate tool declares no roles, and the
  // personal-agent gate keeps a tool that names none of its roles from a personal agent.
  handoff: [{ agent: HelperAgent, roles: [PERSONAL_AGENT_ROLE] }],
})
@Injectable()
class OrchestratorAgent {}

/**
 * The agent on ONE durable engine — operator and worker in this process, every step dispatched over
 * the in-process transport — the deployment a turn must not deadlock in: the Poppy reader waits on
 * the run's stream while the same engine has to execute it.
 */
async function deployment(script: FakeScript) {
  const runtime = await durableRuntime();
  const state = new InMemoryStateStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      runtime.DurableModule.forRoot({
        store: state,
        transport: new runtime.EventEmitterTransport(new runtime.EventEmitter2()),
      }),
      AgentModule.forRoot({
        model: new FakeModelProvider(script),
        store: new InMemoryAgentStore(),
        durable: true,
      }),
      runtime.AgentDurableModule,
    ],
    providers: [HelperAgent, OrchestratorAgent],
  }).compile();
  await moduleRef.init();
  return {
    moduleRef,
    /** The engine's own store: what the runs it executed are read back from. */
    state,
    service: moduleRef.get<PersonalAgentTurnService>(AGENT_SERVICE),
    registry: moduleRef.get<ToolRegistry>(AGENT_TOOL_REGISTRY),
  };
}

async function replyOf(conversations: PoppyConversations, id: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let cursor: string | undefined;
  const events: PoppyEvent[] = [];
  while (Date.now() < deadline) {
    const read = await conversations.read(principal, id, {
      ...(cursor !== undefined ? { cursor } : {}),
      waitMs: 200,
    });
    events.push(...read.events);
    cursor = read.cursor ?? cursor;
    const reply = events.find(
      (e) => e.type === 'message' && (e.message as { role: string }).role === 'company',
    );
    if (reply) return (reply.message as { text: string }).text;
  }
  return null;
}

const open: { conversations: PoppyConversations; moduleRef: TestingModule }[] = [];

afterEach(async () => {
  for (const { conversations, moduleRef } of open.splice(0)) {
    conversations.shutdown();
    await moduleRef.close();
  }
});

describe('Poppy over the durable runner (a single engine)', () => {
  it('answers a turn without waiting on itself', async () => {
    const app = await deployment(() => ({ text: 'Hello from the agent' }));
    const conversations = new PoppyConversations({
      store: new InMemoryPoppyStore(),
      service: app.service,
      toolRoles: (name) => app.registry.spec(name)?.roles,
      timeoutMs: 8000,
      pollMs: 50,
    });
    open.push({ conversations, moduleRef: app.moduleRef });
    const startedAt = Date.now();
    const { conversationId } = await conversations.start(principal, {
      message: { id: 'msg_1', sender: 'agent', text: 'hi' },
    });
    expect(await replyOf(conversations, conversationId, 6000)).toBe('Hello from the agent');
    expect(Date.now() - startedAt).toBeLessThan(5000);
    const turns = await app.state.listRuns({ workflow: 'agent.run' });
    expect(turns.map((run) => run.status)).toEqual(['completed']);
    // The conversation settles: nothing left running for it.
    await sleep(50);
    expect((await conversations.read(principal, conversationId, {})).status).toBe('idle');
  });

  it('answers a turn that delegates to a sub-agent on the same engine', async () => {
    const delegate = delegateToolName({ target: 'helper' });
    const app = await deployment((args, turnIndex) => {
      if (!args.tools.some((tool) => tool.name === delegate)) return { text: 'helper answer' };
      if (turnIndex === 0) {
        return { text: '', toolCall: { name: delegate, input: { task: 'help me' } } };
      }
      return { text: 'All done.' };
    });
    expect(app.registry.spec(delegate)?.roles).toEqual([PERSONAL_AGENT_ROLE]);
    const conversations = new PoppyConversations({
      store: new InMemoryPoppyStore(),
      service: app.service,
      toolRoles: (name) => app.registry.spec(name)?.roles,
      agentName: 'orchestrator',
      timeoutMs: 8000,
      pollMs: 50,
    });
    open.push({ conversations, moduleRef: app.moduleRef });
    const { conversationId } = await conversations.start(principal, {
      message: { id: 'msg_1', sender: 'agent', text: 'coordinate' },
    });
    expect(await replyOf(conversations, conversationId, 7000)).toContain('All done.');
    const runs = await app.state.listRuns({ workflow: 'agent.run' });
    // The orchestrator's turn and the helper's, both finished.
    expect(runs.map((run) => run.status)).toEqual(['completed', 'completed']);
  });
});
