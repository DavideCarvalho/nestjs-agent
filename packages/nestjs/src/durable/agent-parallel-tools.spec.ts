import type { ModelProvider, ModelTurnArgs, ModelTurnResult } from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';
import { AgentDurableModule } from './agent-durable.module.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };

/**
 * Each half is released by the OTHER tool starting, so a turn whose two reads run back to back can
 * never finish. One instance per test module, injected into both tools.
 */
@Injectable()
class Rendezvous {
  private readonly started = new Map<string, () => void>();
  private readonly waits = new Map<string, Promise<void>>();

  private slot(name: string): Promise<void> {
    const existing = this.waits.get(name);
    if (existing !== undefined) return existing;
    const promise = new Promise<void>((resolve) => this.started.set(name, resolve));
    this.waits.set(name, promise);
    return promise;
  }

  async meet(self: string, other: string): Promise<void> {
    const theirs = this.slot(other);
    this.slot(self);
    this.started.get(self)?.();
    await theirs;
  }
}

@AiTool({ name: 'left', kind: 'read', description: 'left', input: z.object({}) })
@Injectable()
class LeftTool {
  constructor(private readonly rendezvous: Rendezvous) {}
  async execute(): Promise<{ side: string }> {
    await this.rendezvous.meet('left', 'right');
    return { side: 'left' };
  }
}

@AiTool({ name: 'right', kind: 'read', description: 'right', input: z.object({}) })
@Injectable()
class RightTool {
  constructor(private readonly rendezvous: Rendezvous) {}
  async execute(): Promise<{ side: string }> {
    await this.rendezvous.meet('right', 'left');
    return { side: 'right' };
  }
}

@Agent({ name: 'default', systemPrompt: 'durable parallel test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

/** Asks for `left` and `right` in ONE turn, then finishes — what a model routinely does. */
class TwoToolModel implements ModelProvider {
  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const turnIndex = args.messages.filter((message) => message.role === 'assistant').length;
    const text = turnIndex === 0 ? 'looking both ways' : 'both sides in';
    await args.sink.write(new TextEncoder().encode(text));
    return {
      text,
      toolCalls:
        turnIndex === 0
          ? [
              { id: 'call-left', name: 'left', input: {} },
              { id: 'call-right', name: 'right', input: {} },
            ]
          : [],
      usage: { inputTokens: args.messages.length, outputTokens: text.length },
    };
  }
}

async function buildDurableApp() {
  const agentStore = new InMemoryAgentStore();
  const stateStore = new InMemoryStateStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store: stateStore,
        transport: new EventEmitterTransport(new EventEmitter2()),
      }),
      AgentModule.forRoot({
        model: new TwoToolModel(),
        store: agentStore,
        durable: true,
        defaultAgent: 'default',
        // Pinned, so this test states which execution path it exercises: the turn's tool calls run
        // as `ctx.localStep`s in the workflow worker.
        dispatchedSteps: false,
      }),
      AgentDurableModule,
    ],
    providers: [Rendezvous, LeftTool, RightTool, DefaultAgent],
  }).compile();
  await moduleRef.init();
  return {
    moduleRef,
    agentStore,
    stateStore,
    service: moduleRef.get(AgentService),
    engine: moduleRef.get(WorkflowEngine),
  };
}

describe('a turn of two read tools under the durable runner', () => {
  it('runs them at the same time and journals every checkpoint in call order', async () => {
    const { moduleRef, agentStore, stateStore, service, engine } = await buildDurableApp();
    try {
      const { runId } = await service.chat({ actor: ACTOR, message: 'look' });
      // Each tool blocks until the other has started, so reaching 'completed' at all is the proof
      // that the two invocations overlapped.
      const result = await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
      expect(result.status).toBe('completed');

      expect(
        agentStore.toolCallRows().map((row) => [row.toolName, row.status, row.output]),
      ).toEqual([
        ['left', 'executed', { side: 'left' }],
        ['right', 'executed', { side: 'right' }],
      ]);

      // The journal the engine itself wrote, at the positions its own counter handed out: the
      // version marker, both claims, both invocations, both persists — each pair in call order.
      const journal = (await stateStore.listCheckpoints(runId))
        .sort((a, b) => a.seq - b.seq)
        .map((checkpoint) => checkpoint.name);
      const marker = journal.indexOf('patch:agent:parallel-tools');
      expect(journal.slice(marker, marker + 7)).toEqual([
        'patch:agent:parallel-tools',
        'persist:toolcall:call-left',
        'persist:toolcall:call-right',
        'tool:call-left',
        'tool:call-right',
        'persist:toolexec:call-left',
        'persist:toolexec:call-right',
      ]);
    } finally {
      await moduleRef.close();
    }
  });
});
