import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AGENT_CHAT_QUEUE } from '../queue/chat-queue.token.js';
import { AgentRunWorkflow } from './agent-run.workflow.js';
import { DurableAgentRunner } from './durable-agent-runner.js';

/** Nest's explicit `@Inject(token)` for a constructor parameter, if it has one. */
function injectedToken(target: object, index: number): unknown {
  const declared = (Reflect.getMetadata('self:paramtypes', target) ?? []) as Array<{
    index: number;
    param: unknown;
  }>;
  return declared.find((entry) => entry.index === index)?.param;
}

/**
 * `/durable` is published as its own bundle, with its own copy of `ChatQueueService`. Asked for by
 * class (and `@Optional()`), the queue resolved to `undefined` in every app built from the package:
 * a message sent while a turn was answering was accepted and never ran. These two must name the
 * queue by a token that is one value across bundles. `scripts/check-dist-nestjs-di.mjs` proves the
 * same thing on the built files, for every secondary entry.
 */
describe('the durable entry asks for the message queue by token', () => {
  it('AgentRunWorkflow', () => {
    expect(injectedToken(AgentRunWorkflow, 3)).toBe(AGENT_CHAT_QUEUE);
  });

  it('DurableAgentRunner', () => {
    expect(injectedToken(DurableAgentRunner, 4)).toBe(AGENT_CHAT_QUEUE);
  });

  it('is the same token in every bundle', () => {
    expect(AGENT_CHAT_QUEUE).toBe(Symbol.for('@dudousxd/nestjs-agent:chat-queue'));
  });
});
