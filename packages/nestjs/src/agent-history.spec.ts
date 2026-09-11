import {
  AGENT_DEPS_FACTORY,
  type AgentStore,
  type HistoryPolicy,
  type ModelMessage,
  type RecordUsageInput,
} from '@dudousxd/nestjs-agent-core';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
} from '@dudousxd/nestjs-agent-testing';
import { Injectable, type Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentDepsFactory } from './agent-deps.factory.js';
import { AgentModule } from './agent.module.js';
import type { AgentModuleOptions } from './agent.options.js';
import { AgentService } from './agent.service.js';
import { Agent } from './decorator/agent.decorator.js';
import { HeaderActorResolver } from './resolver/header-actor-resolver.js';

@Agent({ name: 'default', systemPrompt: 'test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

/** Declares a tighter ceiling than the module's — a persona that only needs the last exchange. */
@Agent({ name: 'terse', systemPrompt: 'terse agent', history: { maxMessages: 1 } })
@Injectable()
class TerseAgent {}

type HistoryOptions = Pick<AgentModuleOptions, 'history' | 'historyPolicy'>;

async function buildApp(
  script: FakeScript,
  options: HistoryOptions = {},
  agents: Type<object>[] = [],
) {
  const store = new InMemoryAgentStore();
  const usage: RecordUsageInput[] = [];
  const recordingStore: AgentStore = Object.assign(Object.create(store) as AgentStore, {
    recordUsage: async (input: RecordUsageInput) => {
      usage.push(input);
      await store.recordUsage(input);
    },
  });
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(script),
        store: recordingStore,
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'default',
        ...(options.history !== undefined ? { history: options.history } : {}),
        ...(options.historyPolicy !== undefined ? { historyPolicy: options.historyPolicy } : {}),
      }),
    ],
    providers: [DefaultAgent, ...agents],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  await app.init();
  return {
    app,
    store,
    usage,
    service: app.get(AgentService),
    factory: app.get<AgentDepsFactory>(AGENT_DEPS_FACTORY),
  };
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const _chunk of iterable) {
    // Drain: the run only settles once its stream has been consumed.
  }
}

function thread(count: number): ModelMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `m${index}`,
  }));
}

function keptContents(policy: HistoryPolicy | undefined, count: number): string[] {
  if (policy === undefined) {
    throw new Error('no history policy was resolved');
  }
  return policy
    .select(thread(count), { threadId: 't1', actor: { id: 'u1' } })
    .keep.map((message) => message.content);
}

describe('history ceiling — module wiring', () => {
  let app: NestExpressApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('leaves the agent unbounded when neither option is set', async () => {
    const built = await buildApp(() => ({ text: 'ok' }));
    app = built.app;
    expect(built.factory.forAgent('default').historyPolicy).toBeUndefined();
  });

  it('trims the turn the model actually receives to the module-wide window', async () => {
    const seen: ModelMessage[][] = [];
    const script: FakeScript = (args) => {
      // Snapshot: the loop keeps appending this turn's assistant message to the same array.
      seen.push([...args.messages]);
      return { text: 'ok' };
    };
    const built = await buildApp(script, { history: { maxMessages: 2 } });
    app = built.app;
    const actor = { id: 'u1', roles: ['ADMIN'] };
    let threadId: string | undefined;
    for (const message of ['one', 'two', 'three']) {
      const chat = await built.service.chat({
        actor,
        message,
        ...(threadId !== undefined ? { threadId } : {}),
      });
      threadId = chat.threadId;
      await collect(built.service.subscribe(chat.runId));
    }
    // The thread now holds 5 prior messages plus 'three'; only the newest two ride into the turn.
    expect(seen[2]?.map((message) => message.content)).toEqual(['ok', 'three']);
  });

  it('an agent’s own `@Agent({ history })` outranks the module window', async () => {
    const built = await buildApp(() => ({ text: 'ok' }), { history: { maxMessages: 4 } }, [
      TerseAgent,
    ]);
    app = built.app;
    expect(keptContents(built.factory.forAgent('default').historyPolicy, 6)).toEqual([
      'm2',
      'm3',
      'm4',
      'm5',
    ]);
    expect(keptContents(built.factory.forAgent('terse').historyPolicy, 6)).toEqual(['m5']);
  });

  it('a custom `historyPolicy` replaces the built-in window, and an agent still overrides it', async () => {
    // A window the built-in cannot express: pin the thread's opening brief alongside the newest.
    const pinFirst: HistoryPolicy = {
      select: (messages) => ({
        keep: [...messages.slice(0, 1), ...messages.slice(-1)],
        drop: messages.slice(1, -1),
      }),
    };
    const built = await buildApp(
      () => ({ text: 'ok' }),
      { history: { maxMessages: 4 }, historyPolicy: pinFirst },
      [TerseAgent],
    );
    app = built.app;
    expect(keptContents(built.factory.forAgent('default').historyPolicy, 6)).toEqual(['m0', 'm5']);
    expect(keptContents(built.factory.forAgent('terse').historyPolicy, 6)).toEqual(['m5']);
  });

  it('`summarize: true` folds the dropped messages in with the module model and bills the call', async () => {
    const turns: { system: string; messages: ModelMessage[] }[] = [];
    const script: FakeScript = (args) => {
      turns.push({ system: args.system, messages: [...args.messages] });
      // The summarizer is the SAME provider, told apart by the instruction it is given.
      return args.system.startsWith('Summarize this conversation')
        ? { text: 'they counted to two' }
        : { text: 'ok' };
    };
    const built = await buildApp(script, { history: { maxMessages: 1, summarize: true } });
    app = built.app;
    const actor = { id: 'u1', roles: ['ADMIN'] };
    let threadId: string | undefined;
    for (const message of ['one', 'two']) {
      const chat = await built.service.chat({
        actor,
        message,
        ...(threadId !== undefined ? { threadId } : {}),
      });
      threadId = chat.threadId;
      await collect(built.service.subscribe(chat.runId));
    }
    // Turn 1 has nothing to drop. Turn 2 summarizes 'one' + its answer, then answers with the
    // summary standing in for them as the leading system message.
    expect(turns.map((turn) => turn.system.startsWith('Summarize this conversation'))).toEqual([
      false,
      true,
      false,
    ]);
    expect(turns[2]?.messages).toEqual([
      { role: 'system', content: expect.stringContaining('they counted to two') },
      { role: 'user', content: 'two' },
    ]);
    expect(built.usage.map((row) => row.purpose)).toEqual(['chat', 'history_summary', 'chat']);
  });
});
