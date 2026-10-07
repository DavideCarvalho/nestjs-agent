import {
  AgentModule,
  type AgentModuleOptions,
  AgentService,
  HeaderActorResolver,
} from '@dudousxd/nestjs-agent';
import type { AgentEngine } from '@dudousxd/nestjs-agent';
import type { AgentStreamEvent } from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import type { DynamicModule, INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { OpenCodeHost, OpenCodeServer, OpenCodeTurnContext } from '../host.js';
import { FakeOpenCode, type FakeScript } from './fake-opencode.js';

/** A host on one in-memory OpenCode server, whose boot id a test can change (a restart). */
export class TestHost implements OpenCodeHost {
  bootId = 'boot-1';
  constructor(readonly fake: FakeOpenCode) {}

  async server(): Promise<OpenCodeServer> {
    return { client: this.fake, key: 'tenant-1', bootId: this.bootId };
  }

  async session(_context: OpenCodeTurnContext) {
    return {
      location: { directory: '/work/u1' },
      permissions: [{ action: '*', resource: '*', effect: 'deny' as const }],
    };
  }
}

export interface Harness {
  app: INestApplication;
  fake: FakeOpenCode;
  host: TestHost;
  store: InMemoryAgentStore;
  service: AgentService;
}

export async function bootEngine(args: {
  engine: (host: TestHost) => AgentEngine;
  script?: FakeScript;
  options?: Partial<AgentModuleOptions>;
  imports?: DynamicModule[];
  providers?: Type<unknown>[];
}): Promise<Harness> {
  const fake = new FakeOpenCode(args.script);
  const host = new TestHost(fake);
  const store = new InMemoryAgentStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ...(args.imports ?? []),
      AgentModule.forRoot({
        engine: args.engine(host),
        store,
        actorResolver: new HeaderActorResolver(),
        ...args.options,
      }),
    ],
    providers: args.providers ?? [],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, fake, host, store, service: app.get(AgentService) };
}

/** Every frame of a run's stream, to its end. */
export async function frames(service: AgentService, runId: string): Promise<AgentStreamEvent[]> {
  return framesUntil(service, runId, () => false);
}

/** Frames until one matching `until` arrives (for runs parked on a person). */
export async function framesUntil(
  service: AgentService,
  runId: string,
  until: (f: AgentStreamEvent) => boolean,
): Promise<AgentStreamEvent[]> {
  const decoder = new TextDecoder();
  const out: AgentStreamEvent[] = [];
  let buffer = '';
  for await (const chunk of service.subscribe(runId)) {
    buffer += decoder.decode(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines.filter(Boolean)) {
      const frame = JSON.parse(line) as AgentStreamEvent;
      out.push(frame);
      if (until(frame)) return out;
    }
  }
  return out;
}

export const textOf = (fs: AgentStreamEvent[]) =>
  fs.flatMap((f) => (f.kind === 'text' ? [f.text] : [])).join('');

export async function eventually(
  check: () => boolean | Promise<boolean>,
  what: string,
): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`never: ${what}`);
}
