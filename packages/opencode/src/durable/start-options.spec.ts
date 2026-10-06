import 'reflect-metadata';
import type { Actor } from '@dudousxd/nestjs-agent-core';
import { DurableModule, RUN_GATEWAY } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore, type RunGateway } from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { HttpException, HttpStatus } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, bootEngine, frames } from '../testing/harness.js';
import { openCodeDurable } from './index.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'], tenantRef: 't1' };

const durableModule = () =>
  DurableModule.forRoot({
    store: new InMemoryStateStore(),
    transport: new EventEmitterTransport(new EventEmitter2()),
  });

describe('openCodeDurable start options', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.app.close();
    h = undefined;
  });

  it("names runs and starts them the host's way", async () => {
    h = await bootEngine({
      engine: (host) =>
        openCodeDurable({
          host,
          runId: (input) => `turn:${input.actor.tenantRef}:${crypto.randomUUID()}`,
          durable: {
            start: (input) => ({
              tags: ['chat', `tenant:${input.actor.tenantRef}`],
              searchAttributes: { tenantId: input.actor.tenantRef ?? '' },
            }),
          },
        }),
      imports: [durableModule()],
    });
    const { runId } = await h.service.chat({ actor, message: 'hi' });
    expect(runId).toMatch(/^turn:t1:[0-9a-f-]{36}$/);
    await frames(h.service, runId);
    const detail = await h.app.get<RunGateway>(RUN_GATEWAY).getRunDetail(runId);
    expect(detail?.run.tags).toEqual(expect.arrayContaining(['chat', 'tenant:t1']));
  });

  it('turns a refused start into what the host says', async () => {
    h = await bootEngine({
      engine: (host) =>
        openCodeDurable({
          host,
          durable: {
            start: () => ({ concurrency: { key: 'tenant:t1', limit: 0 } }),
            startError: () =>
              new HttpException('Too many turns at once', HttpStatus.TOO_MANY_REQUESTS),
          },
        }),
      imports: [durableModule()],
    });
    await expect(h.service.chat({ actor, message: 'hi' })).rejects.toThrow(
      'Too many turns at once',
    );
  });
});
