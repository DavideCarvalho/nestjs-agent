import { AgentModule, AgentService } from '@dudousxd/nestjs-agent';
import {
  AGENT_CHANNEL_FOLLOWER,
  type ChannelFollower,
  InMemoryAgentStore,
} from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider } from '@dudousxd/nestjs-agent-testing';
import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { Inject, Injectable, Module, Optional } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AgentChannelsModule } from './agent-channels.module.js';
import { AgentChannelsService } from './agent-channels.service.js';
import { actor, channel, fakeAdapter, fakeService, texts, until } from './channels.spec-helper.js';
import type { ChannelWorkflowEngine } from './executor.js';
import type { ChannelTurnEnded } from './handler.js';

const engineOver = (store: InMemoryStateStore) =>
  new WorkflowEngine({ store }) as unknown as ChannelWorkflowEngine & WorkflowEngine;

const run = { runId: 'run-9', threadId: 'thread-9', actor };

describe('ChannelHandler.follow — a run the channel did not start', () => {
  it('reads the run and delivers it to the conversation, once per run', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService([{ kind: 'text', text: 'Connected — your order is placed.' }]);
    const ended: ChannelTurnEnded[] = [];
    const handler = channel(adapter, service, {
      onTurnEnded: (turn) => {
        ended.push(turn);
      },
    });
    await handler.follow('chat-7', run);
    await handler.follow('chat-7', run);
    await handler.drain();
    expect(service.sends).toEqual([]);
    expect(service.subscribed).toEqual(['run-9']);
    expect(outbox).toEqual([
      { conversation: 'chat-7', message: { text: 'Connected — your order is placed.' } },
    ]);
    expect(ended).toEqual([
      {
        channel: 'test',
        conversation: 'chat-7',
        actor,
        message: null,
        runId: 'run-9',
        threadId: 'thread-9',
        outcome: 'replied',
      },
    ]);
  });

  it('runs as a durable job under a durable engine', async () => {
    const engine = engineOver(new InMemoryStateStore());
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService([{ kind: 'text', text: 'Done.' }]);
    const handler = channel(adapter, service, { engine });
    await handler.follow('chat-7', run);
    const job = await engine.getRun('agora.channel:test:follow:run-9');
    expect(job?.workflow).toBe('agora.channel.job');
    expect(job?.input).toMatchObject({ kind: 'resume', conversation: 'chat-7', runId: 'run-9' });
    await handler.follow('chat-7', run);
    await handler.drain();
    expect(texts(outbox)).toEqual(['Done.']);
    expect(service.subscribed).toEqual(['run-9']);
  });
});

@Injectable()
class Continuer {
  constructor(@Optional() @Inject(AGENT_CHANNEL_FOLLOWER) readonly follower?: ChannelFollower) {}
}

@Module({ providers: [Continuer], exports: [Continuer] })
class ContinuerModule {}

describe('AgentChannelsService.follow — AGENT_CHANNEL_FOLLOWER', () => {
  it('is injectable by another module, and delivers a server-started run to the channel it names', async () => {
    const { adapter, outbox } = fakeAdapter();
    const module = await Test.createTestingModule({
      imports: [
        AgentModule.forRoot({
          store: new InMemoryAgentStore(),
          actorResolver: { resolve: () => actor },
          model: new FakeModelProvider(() => ({ text: 'Signed in. Placing the order now.' })),
        }),
        AgentChannelsModule.forRoot({
          path: false,
          channels: [{ adapter, actor: () => actor, thread: () => null }],
        }),
        ContinuerModule,
      ],
    }).compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      const { follower } = app.get(Continuer);
      expect(follower).toBe(app.get(AgentChannelsService));
      // A turn the server started on its own (no channel message behind it).
      const started = await app.get(AgentService).send({ actor, message: 'continue' });
      if (!('runId' in started) || started.runId === undefined) throw new Error('no run started');
      const followed = { runId: started.runId, threadId: started.threadId, actor };
      expect(await follower?.follow({ name: 'nope', conversation: 'chat-7' }, followed)).toBe(
        false,
      );
      expect(await follower?.follow({ name: 'test' }, followed)).toBe(false);
      expect(await follower?.follow(null, followed)).toBe(false);
      expect(
        await follower?.follow({ name: 'test', conversation: 'chat-7', kind: 'test' }, followed),
      ).toBe(true);
      await until(() => outbox.length === 1);
      expect(outbox).toEqual([
        { conversation: 'chat-7', message: { text: 'Signed in. Placing the order now.' } },
      ]);
    } finally {
      await app.close();
    }
  });
});
