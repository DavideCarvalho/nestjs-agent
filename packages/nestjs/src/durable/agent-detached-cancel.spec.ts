import type { AgentLoopResult, AgentRunInput, StoredMessage } from '@dudousxd/nestjs-agent-core';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
} from '@dudousxd/nestjs-agent-testing';
import { DurableModule } from '@dudousxd/nestjs-durable';
import {
  InMemoryStateStore,
  type WorkflowCtx,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
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
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';
import { AgentDurableModule } from './agent-durable.module.js';
import { AgentRunWorkflow } from './agent-run.workflow.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };

/** Counts executions across every process a test boots, so a replay that re-ran a tool shows. */
const executions: Record<string, number> = {};

/** What the research agent does — it needs a human, so it parks on its own run. */
@AiTool({ name: 'purgeCache', kind: 'action', description: 'purge', input: z.object({}) })
@Injectable()
class PurgeCacheTool {
  async execute() {
    executions.purgeCache = (executions.purgeCache ?? 0) + 1;
    return { purged: true };
  }
}

/** What the orchestrator does around the delegation — it needs a human too, so the turn stays live. */
@AiTool({ name: 'shipIt', kind: 'action', description: 'ship', input: z.object({}) })
@Injectable()
class ShipItTool {
  async execute() {
    executions.shipIt = (executions.shipIt ?? 0) + 1;
    return { shipped: true };
  }
}

@Agent({ name: 'research', systemPrompt: 'research worker', tools: ['purgeCache'] })
@Injectable()
class ResearchAgent {}

@Agent({
  name: 'orch',
  systemPrompt: 'orchestrator',
  tools: ['shipIt'],
  handoff: [{ agent: ResearchAgent, detached: true }],
})
@Injectable()
class OrchestratorAgent {}

const research = (turnIndex: number) =>
  turnIndex === 0
    ? { text: 'digging', toolCall: { name: 'purgeCache', input: {} } }
    : { text: 'RESEARCH ANSWER' };

/** The orchestrator starts the research agent in the background, THEN parks on its own action. */
const detachThenPark: FakeScript = (args, turnIndex) => {
  if (args.system.includes('research worker')) {
    return research(turnIndex);
  }
  if (turnIndex === 0) {
    return { text: 'starting', toolCall: { name: 'start_research', input: { task: 'dig' } } };
  }
  if (turnIndex === 1) {
    return { text: 'shipping', toolCall: { name: 'shipIt', input: {} } };
  }
  return { text: 'orchestrator done' };
};

/** The other order: parks on its own action first, and only detaches in the step after it. */
const parkThenDetach: FakeScript = (args, turnIndex) => {
  if (args.system.includes('research worker')) {
    return research(turnIndex);
  }
  if (turnIndex === 0) {
    return { text: 'shipping', toolCall: { name: 'shipIt', input: {} } };
  }
  if (turnIndex === 1) {
    return { text: 'starting', toolCall: { name: 'start_research', input: { task: 'dig' } } };
  }
  return { text: 'orchestrator done' };
};

/**
 * The `agent.run` body as the release before this one journaled a detached delegation: a
 * `ctx.startChild` (`spawn:<id>`) straight after the `subthread:` step. `ctx.patched` answering
 * `false` without spending a position is exactly what the real one answers on a replay of such a
 * run, whose position holds the `spawn:` — there is no configuration that writes that shape any more.
 */
@Injectable()
class SpawnJournalWorkflow extends AgentRunWorkflow {
  override run(ctx: WorkflowCtx, input: AgentRunInput): Promise<AgentLoopResult> {
    const legacy: WorkflowCtx = {
      ...ctx,
      patched: (id) =>
        id === 'agent:detached-unlinked' ? Promise.resolve(false) : ctx.patched(id),
    };
    return super.run(legacy, input);
  }
}

interface Shared {
  stateStore: InMemoryStateStore;
  agentStore: InMemoryAgentStore;
}

/** One process. Booting a second over the same `shared` is a restart: every resume is a replay. */
async function boot(shared: Shared, script: FakeScript, options?: { legacy?: boolean }) {
  const builder = Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store: shared.stateStore,
        transport: new EventEmitterTransport(new EventEmitter2()),
      }),
      AgentModule.forRoot({
        model: new FakeModelProvider(script),
        store: shared.agentStore,
        actorResolver: new HeaderActorResolver(),
        durable: true,
        defaultAgent: 'orch',
      }),
      AgentDurableModule,
    ],
    providers: [PurgeCacheTool, ShipItTool, ResearchAgent, OrchestratorAgent],
  });
  const moduleRef = await (options?.legacy === true
    ? builder.overrideProvider(AgentRunWorkflow).useClass(SpawnJournalWorkflow)
    : builder
  ).compile();
  await moduleRef.init();
  return {
    moduleRef,
    service: moduleRef.get(AgentService),
    engine: moduleRef.get(WorkflowEngine),
  };
}

function fresh(): Shared {
  for (const key of Object.keys(executions)) {
    delete executions[key];
  }
  return { stateStore: new InMemoryStateStore(), agentStore: new InMemoryAgentStore() };
}

async function eventually<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function parked(store: InMemoryAgentStore, toolName: string) {
  return eventually(
    async () =>
      store
        .toolCallRows()
        .find((row) => row.toolName === toolName && row.status === 'pending_approval'),
    `${toolName} to park on a human`,
  );
}

async function journal(stateStore: InMemoryStateStore, runId: string): Promise<string[]> {
  return (await stateStore.listCheckpoints(runId))
    .sort((left, right) => left.seq - right.seq)
    .map((checkpoint) => checkpoint.name);
}

function receipt(store: InMemoryAgentStore) {
  return store.toolCallRows().find((row) => row.toolName === 'start_research')?.output;
}

async function delivered(store: InMemoryAgentStore, threadId: string): Promise<StoredMessage[]> {
  await eventually(
    async () =>
      (await store.getThread(threadId))?.messages.find((m) => m.content === 'RESEARCH ANSWER'),
    'the detached answer to be delivered',
  );
  return ((await store.getThread(threadId))?.messages ?? []).filter(
    (m) => m.content === 'RESEARCH ANSWER',
  );
}

describe('stopping a turn that already started a detached sub-agent', () => {
  it('leaves the detached run working, and the card follows it to its real outcome', async () => {
    const shared = fresh();
    const { moduleRef, service, engine } = await boot(shared, detachThenPark);
    try {
      const { runId, threadId } = await service.chat({ actor: ACTOR, message: 'go' });
      const child = await parked(shared.agentStore, 'purgeCache');
      await parked(shared.agentStore, 'shipIt');
      const childRunId = child.runId ?? '';

      await service.cancel(ACTOR, runId);
      expect((await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' })).status).toBe(
        'cancelled',
      );

      // The Stop was for the turn the person was watching; the background run was never part of it.
      expect((await engine.getRun(childRunId))?.status).not.toMatch(/^cancel/);
      expect(receipt(shared.agentStore)).toMatchObject({ detached: true, status: 'started' });

      await service.approve(ACTOR, child.toolCallId);
      await engine.waitForRun(childRunId, { timeoutMs: 5000, until: 'terminal' });
      expect(await delivered(shared.agentStore, threadId)).toHaveLength(1);
      expect(receipt(shared.agentStore)).toMatchObject({
        detached: true,
        status: 'delivered',
        runId: childRunId,
      });
      expect(executions.purgeCache).toBe(1);
      expect(executions.shipIt).toBeUndefined();
    } finally {
      await moduleRef.close();
    }
  });

  it('still lets the detached run be stopped by its own id, and says so in the thread', async () => {
    const shared = fresh();
    const { moduleRef, service, engine } = await boot(shared, detachThenPark);
    try {
      const { runId, threadId } = await service.chat({ actor: ACTOR, message: 'go' });
      const child = await parked(shared.agentStore, 'purgeCache');
      await parked(shared.agentStore, 'shipIt');
      await service.cancel(ACTOR, runId);

      await service.cancel(ACTOR, child.runId ?? '');
      await eventually(
        async () =>
          (receipt(shared.agentStore) as { status?: string } | undefined)?.status === 'cancelled'
            ? true
            : undefined,
        'the card to say the detached run was stopped',
      );
      const told = ((await shared.agentStore.getThread(threadId))?.messages ?? []).filter((m) =>
        m.content.includes('was stopped before it could answer'),
      );
      expect(told).toHaveLength(1);
      expect((await engine.getRun(child.runId ?? ''))?.status).toMatch(/^cancel/);
    } finally {
      await moduleRef.close();
    }
  });
});

describe('a detached delegation replays across restarts', () => {
  /**
   * Every signal lands on a process that did not run the turn before it, so each resume replays
   * the whole body from the journal — in both orders the two humans can answer in.
   */
  for (const order of [
    ['purgeCache', 'shipIt'],
    ['shipIt', 'purgeCache'],
  ] as const) {
    it(`starts the child once and delivers once when ${order.join(' then ')} is approved`, async () => {
      const shared = fresh();
      let runId = '';
      let threadId = '';
      const first = await boot(shared, detachThenPark);
      try {
        ({ runId, threadId } = await first.service.chat({ actor: ACTOR, message: 'go' }));
        await parked(shared.agentStore, 'purgeCache');
        await parked(shared.agentStore, 'shipIt');
      } finally {
        await first.moduleRef.close();
      }

      for (const toolName of order) {
        const next = await boot(shared, detachThenPark);
        try {
          const row = await parked(shared.agentStore, toolName);
          await next.service.approve(ACTOR, row.toolCallId);
          await next.engine.waitForRun(row.runId ?? '', { timeoutMs: 5000, until: 'terminal' });
          await eventually(
            async () =>
              shared.agentStore.toolCallRows().find((r) => r.toolCallId === row.toolCallId)
                ?.status === 'executed'
                ? true
                : undefined,
            `${toolName} to execute`,
          );
        } finally {
          await next.moduleRef.close();
        }
      }

      expect(await delivered(shared.agentStore, threadId)).toHaveLength(1);
      expect(executions).toEqual({ purgeCache: 1, shipIt: 1 });
      const parent = await journal(shared.stateStore, runId);
      expect(parent.filter((name) => name.startsWith('detach:'))).toHaveLength(1);
      expect(parent.filter((name) => name.startsWith('spawn:'))).toEqual([]);
      expect(parent).toContain('patch:agent:detached-unlinked');
      expect((await shared.stateStore.listRuns({})).filter((run) => run.id !== runId)).toHaveLength(
        1,
      );
    });
  }
});

describe('a run parked before this release', () => {
  it('replays the `spawn:` it already journaled, and the child it started still delivers', async () => {
    const shared = fresh();
    let runId = '';
    let threadId = '';
    const before = await boot(shared, detachThenPark, { legacy: true });
    try {
      ({ runId, threadId } = await before.service.chat({ actor: ACTOR, message: 'go' }));
      await parked(shared.agentStore, 'purgeCache');
      await parked(shared.agentStore, 'shipIt');
      expect((await journal(shared.stateStore, runId)).some((n) => n.startsWith('spawn:'))).toBe(
        true,
      );
    } finally {
      await before.moduleRef.close();
    }

    const after = await boot(shared, detachThenPark);
    try {
      for (const toolName of ['shipIt', 'purgeCache']) {
        const row = await parked(shared.agentStore, toolName);
        await after.service.approve(ACTOR, row.toolCallId);
        const settled = await after.engine.waitForRun(row.runId ?? '', {
          timeoutMs: 5000,
          until: 'terminal',
        });
        expect(settled.status).toBe('completed');
      }
      expect(await delivered(shared.agentStore, threadId)).toHaveLength(1);
      expect(executions).toEqual({ purgeCache: 1, shipIt: 1 });
      const parent = await journal(shared.stateStore, runId);
      expect(parent).not.toContain('patch:agent:detached-unlinked');
      expect(parent.filter((name) => name.startsWith('spawn:'))).toHaveLength(1);
      expect(parent.filter((name) => name.startsWith('detach:'))).toEqual([]);
    } finally {
      await after.moduleRef.close();
    }
  });

  /**
   * A parent that journaled `spawn:` still owns its child in the runtime's eyes, so a Stop on it
   * still cascades — that run's shape cannot change after the fact. What CAN change is that the
   * card no longer says "started" for a run that is gone.
   */
  it('settles the card when stopping such a parent takes its spawned child with it', async () => {
    const shared = fresh();
    let runId = '';
    let threadId = '';
    const before = await boot(shared, detachThenPark, { legacy: true });
    try {
      ({ runId, threadId } = await before.service.chat({ actor: ACTOR, message: 'go' }));
      await parked(shared.agentStore, 'purgeCache');
      await parked(shared.agentStore, 'shipIt');
    } finally {
      await before.moduleRef.close();
    }

    const after = await boot(shared, detachThenPark);
    try {
      await after.service.cancel(ACTOR, runId);
      await eventually(
        async () =>
          (receipt(shared.agentStore) as { status?: string } | undefined)?.status === 'cancelled'
            ? true
            : undefined,
        'the card to say the cascaded child was stopped',
      );
      const told = ((await shared.agentStore.getThread(threadId))?.messages ?? []).filter((m) =>
        m.content.includes('was stopped before it could answer'),
      );
      expect(told).toHaveLength(1);
      expect(executions.purgeCache).toBeUndefined();
    } finally {
      await after.moduleRef.close();
    }
  });

  it('detaches on the new shape when the delegation comes after the upgrade', async () => {
    const shared = fresh();
    let runId = '';
    let threadId = '';
    const before = await boot(shared, parkThenDetach, { legacy: true });
    try {
      ({ runId, threadId } = await before.service.chat({ actor: ACTOR, message: 'go' }));
      await parked(shared.agentStore, 'shipIt');
    } finally {
      await before.moduleRef.close();
    }

    const after = await boot(shared, parkThenDetach);
    try {
      const ship = await parked(shared.agentStore, 'shipIt');
      await after.service.approve(ACTOR, ship.toolCallId);
      expect(
        (await after.engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' })).status,
      ).toBe('completed');
      const child = await parked(shared.agentStore, 'purgeCache');
      await after.service.approve(ACTOR, child.toolCallId);
      await after.engine.waitForRun(child.runId ?? '', { timeoutMs: 5000, until: 'terminal' });

      expect(await delivered(shared.agentStore, threadId)).toHaveLength(1);
      const parent = await journal(shared.stateStore, runId);
      expect(parent).toContain('patch:agent:detached-unlinked');
      expect(parent.filter((name) => name.startsWith('detach:'))).toHaveLength(1);
      expect(parent.filter((name) => name.startsWith('spawn:'))).toEqual([]);
    } finally {
      await after.moduleRef.close();
    }
  });
});
