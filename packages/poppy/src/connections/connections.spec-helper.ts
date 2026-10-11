import { createServer } from 'node:net';
import { AgentModule, type AgentModuleOptions, AgentService } from '@dudousxd/nestjs-agent';
import {
  AGENT_CHANNEL_FOLLOWER,
  type AiToolCtx,
  type ChannelFollower,
  InMemoryAgentStore,
  InMemoryPoppyConnectionStore,
  type ToolHandler,
  type ToolSpec,
} from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider } from '@dudousxd/nestjs-agent-testing';
import type { INestApplication, Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { expect } from 'vitest';
import { generateEs256Key } from '../client/keys.js';
import { FakeCompany, type FakeOptions } from '../client/testing/fake-company.spec-helper.js';
import { AgentPoppyConnectionsModule } from './agent-poppy-connections.module.js';
import type { AgentPoppyConnectionsModuleOptions } from './config.js';
import { PoppyConnections } from './service.js';
import { registerPoppyConnectionTools } from './tools.js';

export const SECRET = 'x'.repeat(32);
export const owner = { id: 'profile-1', tenantRef: 'account-1' };

export type Tools = Map<string, { spec: ToolSpec; handler: ToolHandler<any> }>;

export interface App {
  fake: FakeCompany;
  nest: INestApplication;
  connections: PoppyConnections;
  store: InMemoryPoppyConnectionStore;
  agentStore: InMemoryAgentStore;
  service: AgentService;
  base: string;
  /** The tools as registered (a capture of `registerPoppyConnectionTools`, same options). */
  tools: Tools;
  close(): Promise<void>;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

export function required<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`missing ${what}`);
  return value;
}

/** A capturing registry: what `registerPoppyConnectionTools` registers, by name. */
export function capture(tools: Tools = new Map()) {
  return {
    tools,
    register: (spec: ToolSpec, handler: ToolHandler<any>) => {
      tools.set(spec.name, { spec, handler });
    },
  };
}

/**
 * A fake Company and THIS app's agent side: `AgentModule` (in-memory store, a scripted model) and
 * `AgentPoppyConnectionsModule`, served on a real port — the Company's sign-in redirects to it.
 */
export async function setup(
  options: {
    connections?: Partial<AgentPoppyConnectionsModuleOptions>;
    fake?: FakeOptions;
    agent?: Partial<AgentModuleOptions>;
    agentStore?: InMemoryAgentStore;
    follower?: ChannelFollower;
  } = {},
): Promise<App> {
  const fake = await new FakeCompany(options.fake ?? {}).start();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const store = new InMemoryPoppyConnectionStore();
  const agentStore = options.agentStore ?? new InMemoryAgentStore();
  const providers: Provider[] = options.follower
    ? [{ provide: AGENT_CHANNEL_FOLLOWER, useValue: options.follower }]
    : [];
  const module = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        store: agentStore,
        model: new FakeModelProvider(() => ({ text: 'ok' })),
        actorResolver: { resolve: () => owner },
        backgroundActorResolver: { resolve: async () => owner },
        actionProposalWorker: { pollIntervalMs: 20 },
        ...options.agent,
      }),
      AgentPoppyConnectionsModule.forRoot({
        baseUrl: base,
        identity: {
          name: 'Acme Assistant',
          keys: [(await generateEs256Key()).privateJwk as Record<string, unknown>],
        },
        secret: SECRET,
        companies: [fake.domain],
        insecureDev: true,
        store,
        ...options.connections,
      }),
    ],
    providers,
  }).compile();
  const nest = module.createNestApplication({ logger: false });
  await nest.listen(port, '127.0.0.1');
  const connections = nest.get(PoppyConnections);
  const tools = capture().tools;
  registerPoppyConnectionTools(capture(tools), connections, options.connections?.tools ?? {});
  return {
    fake,
    nest,
    connections,
    store,
    agentStore,
    service: nest.get(AgentService),
    base,
    tools,
    async close() {
      await nest.close();
      await fake.stop();
    },
  };
}

export const ctx = (callId = 'call-1', actor: AiToolCtx['actor'] = owner): AiToolCtx =>
  ({
    actor,
    threadId: 'thread-1',
    runId: 'run-1',
    requestId: 'req-1',
    toolCallId: callId,
  }) as AiToolCtx;

function toolOf(a: App, name: string) {
  return required(a.tools.get(`poppy_${name}`), `poppy_${name}`).handler;
}

export async function tool(a: App, name: string, input: unknown, callId?: string) {
  return toolOf(a, name).execute(input, ctx(callId));
}

export async function preflight(a: App, name: string, input: unknown, callId?: string) {
  const handler = toolOf(a, name);
  return required(handler.preflight, 'preflight').call(handler, input, ctx(callId), {
    phase: 'prepare',
  });
}

/** The `connect` card's link (its detail). */
export async function connectLink(
  a: App,
  input: Record<string, unknown> = {},
  callId?: string,
): Promise<string> {
  const pre = (await preflight(a, 'connect', { company: a.fake.domain, ...input }, callId)) as {
    status: string;
    confirmation: { detail: string; link?: string };
  };
  expect(pre.status).toBe('ready');
  const link = required(/(http:\/\/\S+\/connect\/\S+)$/.exec(pre.confirmation.detail)?.[1]);
  // The card's action is the link (a channel sends it with no reply buttons).
  expect(pre.confirmation.link).toBe(link);
  return link;
}

/** Plays the person's browser through Direct Sign-In from the connect page. */
export async function direct(link: string): Promise<string> {
  const toCompany = await fetch(`${link}/direct`, { method: 'POST', redirect: 'manual' });
  expect(toCompany.status).toBe(303);
  const authorize = await fetch(required(toCompany.headers.get('location')), {
    redirect: 'manual',
  });
  const callback = await fetch(required(authorize.headers.get('location')));
  return callback.text();
}

/** Waits until `ok` holds. */
export async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`never: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
