import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  APPROVAL_EXPIRED_REASON,
  type AgentLoopDeps,
  type AgentLoopHooks,
  type AgentStreamEvent,
  type ApprovalPolicy,
  type Decision,
  DefaultRolesPolicy,
  type ModelMessage,
  type ToolPreflightResult,
  ToolRegistry,
  decodeStreamEvent,
  runAgentLoop,
} from './index.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };

function registry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(
    {
      name: 'purgeCache',
      kind: 'action',
      description: 'purge',
      inputSchema: z.object({ key: z.string() }),
    },
    { execute: async (input: { key: string }) => ({ purged: input.key }) },
  );
  return reg;
}

/** A run's first step purges, its next one answers — however much history the thread holds. */
const purgeOnce: FakeScript = (args) =>
  args.messages.at(-1)?.role === 'user'
    ? { text: 'purging', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
    : { text: 'done' };

interface Harness {
  store: InMemoryAgentStore;
  threadId: string;
}

async function harness(): Promise<Harness> {
  const store = new InMemoryAgentStore();
  const thread = await store.createThread({ actor: ACTOR });
  return { store, threadId: thread.id };
}

interface RunResult {
  events: AgentStreamEvent[];
  awaited: Array<{ id: string; opts: { timeoutMs?: number } | undefined }>;
  messages: ModelMessage[][];
}

async function run(
  h: Harness,
  options: {
    runId?: string;
    decide?: (id: string) => Decision;
    policy?: ApprovalPolicy;
    script?: FakeScript;
    step?: AgentLoopHooks['step'];
    registry?: ToolRegistry;
    toolAllowList?: string[];
    toolTransientRetry?: AgentLoopDeps['toolTransientRetry'];
  } = {},
): Promise<RunResult> {
  const runId = options.runId ?? 'run-1';
  const sink = new InMemoryTokenStreamSink();
  const awaited: RunResult['awaited'] = [];
  const messages: ModelMessage[][] = [];
  const script = options.script ?? purgeOnce;
  const deps: AgentLoopDeps = {
    model: new FakeModelProvider((args, turnIndex) => {
      messages.push(args.messages);
      return script(args, turnIndex);
    }),
    store: h.store,
    registry: options.registry ?? registry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'test',
    ...(options.toolAllowList !== undefined ? { toolAllowList: options.toolAllowList } : {}),
    ...(options.toolTransientRetry !== undefined
      ? { toolTransientRetry: options.toolTransientRetry }
      : {}),
    ...(options.policy !== undefined ? { approvalPolicy: options.policy } : {}),
  };
  const hooks: AgentLoopHooks = {
    runId,
    openSink: () => sink.open(runId),
    awaitApproval: async (call, _ctx, opts) => {
      awaited.push({ id: call.id, opts });
      return (options.decide ?? (() => ({ approved: true })))(call.id);
    },
    step: options.step ?? ((_name, fn) => fn()),
  };
  await runAgentLoop(deps, { threadId: h.threadId, actor: ACTOR, userText: 'purge it' }, hooks);
  const decoder = new TextDecoder();
  let raw = '';
  for await (const chunk of sink.subscribe(runId)) {
    raw += decoder.decode(chunk);
  }
  const events: AgentStreamEvent[] = [];
  for (const line of raw.split('\n')) {
    const start = line.lastIndexOf('{"kind":"');
    const event = start === -1 ? null : decodeStreamEvent(line.slice(start));
    if (event !== null) {
      events.push(event);
    }
  }
  return { events, awaited, messages };
}

describe('approvals v2 — the approval policy', () => {
  it('asks the requester by default, streams who decides, and records how it was approved', async () => {
    const h = await harness();
    const { events, awaited } = await run(h, {
      decide: () => ({ approved: true, decidedVia: 'web', executedByRef: 'u1' }),
    });

    expect(awaited).toEqual([{ id: 'call-0-purgeCache', opts: undefined }]);
    expect(events).toContainEqual({
      kind: 'approval-requested',
      id: 'call-0-purgeCache',
      approver: 'requester',
    });
    expect(events).toContainEqual({
      kind: 'approval-settled',
      id: 'call-0-purgeCache',
      status: 'approved',
      decidedBy: 'u1',
      decidedVia: 'web',
    });
    expect(h.store.toolCallRows()[0]).toMatchObject({
      status: 'executed',
      approver: 'requester',
      executedByRef: 'u1',
      decidedVia: 'web',
    });
    const thread = await h.store.getThread(h.threadId);
    const assistant = thread?.messages.find((message) => message.toolCalls !== undefined);
    expect(assistant?.approvals).toEqual([
      {
        toolCallId: 'call-0-purgeCache',
        approver: 'requester',
        status: 'approved',
        decidedBy: 'u1',
        decidedVia: 'web',
      },
    ]);
  });

  it("fills the tool's confirm template on the server for an ordinary approval", async () => {
    const h = await harness();
    const reg = new ToolRegistry();
    reg.register(
      {
        name: 'purgeCache',
        kind: 'action',
        description: 'purge',
        inputSchema: z.object({ key: z.string() }),
        presentation: {
          label: 'Cache purge',
          running: 'Purging {key}',
          done: 'Purged {key}',
          confirm: { title: 'Purge {key}?', verb: 'Purge', detail: 'Key {key} {missing}' },
        },
      },
      { execute: async (input: { key: string }) => ({ purged: input.key }) },
    );
    const { events } = await run(h, { registry: reg });
    const confirmation = { title: 'Purge cfg?', verb: 'Purge', detail: 'Key cfg' };
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'approval-requested', confirmation }),
    );
    const thread = await h.store.getThread(h.threadId);
    expect(thread?.messages.flatMap((message) => message.approvals ?? [])).toEqual([
      expect.objectContaining({ status: 'approved', confirmation }),
    ]);
  });

  it('parks on the approver and time to live the policy names', async () => {
    const h = await harness();
    const seen: unknown[] = [];
    const policy: ApprovalPolicy = {
      requirementFor: (tool, actor, thread) => {
        seen.push({ tool: tool.name, kind: tool.kind, actor: actor.id, thread: thread.threadId });
        return { required: true, approver: 'admin', ttlMs: 60_000 };
      },
    };
    const before = Date.now();
    const { events, awaited } = await run(h, { policy });

    expect(seen).toEqual([{ tool: 'purgeCache', kind: 'action', actor: 'u1', thread: h.threadId }]);
    expect(awaited).toEqual([{ id: 'call-0-purgeCache', opts: { timeoutMs: 60_000 } }]);
    const requested = events.find((event) => event.kind === 'approval-requested');
    expect(requested).toMatchObject({ approver: 'admin' });
    const expiresAt = Date.parse((requested as { expiresAt: string }).expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(h.store.toolCallRows()[0]).toMatchObject({
      approver: 'admin',
      expiresAt: new Date(expiresAt).toISOString(),
    });
  });

  it('runs an action the policy does not require approval for, without parking', async () => {
    const h = await harness();
    const { events, awaited } = await run(h, {
      policy: { requirementFor: () => ({ required: false, approver: 'requester' }) },
    });

    expect(awaited).toEqual([]);
    expect(events.some((event) => event.kind === 'approval-requested')).toBe(false);
    expect(events.some((event) => event.kind === 'approval-settled')).toBe(false);
    const row = h.store.toolCallRows()[0];
    expect(row).toMatchObject({ toolType: 'action', status: 'executed' });
    expect(row?.approver).toBeUndefined();
  });

  it('records and streams a rejection with the surface it came through', async () => {
    const h = await harness();
    const { events } = await run(h, {
      decide: () => ({ approved: false, reason: 'not now', decidedVia: 'slack' }),
    });

    expect(events).toContainEqual({
      kind: 'approval-settled',
      id: 'call-0-purgeCache',
      status: 'rejected',
      decidedBy: 'u1',
      decidedVia: 'slack',
      reason: 'not now',
    });
    expect(h.store.toolCallRows()[0]).toMatchObject({ status: 'rejected', decidedVia: 'slack' });
    const thread = await h.store.getThread(h.threadId);
    expect(thread?.messages.flatMap((message) => message.approvals ?? [])).toEqual([
      {
        toolCallId: 'call-0-purgeCache',
        approver: 'requester',
        status: 'rejected',
        decidedBy: 'u1',
        decidedVia: 'slack',
        reason: 'not now',
      },
    ]);
  });
});

describe('approvals v2 — expiry', () => {
  it('settles an expired call as a denial the model is told lapsed', async () => {
    const h = await harness();
    const { events, messages } = await run(h, {
      policy: { requirementFor: () => ({ required: true, approver: 'admin', ttlMs: 1000 }) },
      decide: () => ({ approved: false, expired: true }),
    });

    expect(h.store.toolCallRows()[0]).toMatchObject({
      status: 'expired',
      error: APPROVAL_EXPIRED_REASON,
    });
    expect(events).toContainEqual({
      kind: 'tool-output-denied',
      id: 'call-0-purgeCache',
      reason: APPROVAL_EXPIRED_REASON,
    });
    expect(events).toContainEqual({
      kind: 'approval-settled',
      id: 'call-0-purgeCache',
      status: 'expired',
    });
    // The next model step reads the call as denied, with a narrative that says nobody decided.
    const followUp = messages[1] ?? [];
    const result = followUp.flatMap((message) => message.toolResults ?? [])[0];
    expect(result).toMatchObject({ denied: true, expired: true });
    expect(result?.error).toContain('expired before anyone decided');
    const thread = await h.store.getThread(h.threadId);
    expect(thread?.messages.flatMap((message) => message.approvals ?? [])).toEqual([
      expect.objectContaining({ status: 'expired', approver: 'admin' }),
    ]);
  });
});

describe('approvals v2 — remembered approvals', () => {
  it('approves a later call of the same tool in the same thread without asking', async () => {
    const h = await harness();
    await run(h, { decide: () => ({ approved: true, remember: true, decidedVia: 'web' }) });
    expect(await h.store.rememberedApprovals(h.threadId)).toEqual(['purgeCache']);

    const second = await run(h, { runId: 'run-2' });
    expect(second.awaited).toEqual([]);
    expect(second.events.some((event) => event.kind === 'approval-requested')).toBe(false);
    expect(second.events).toContainEqual(
      expect.objectContaining({
        kind: 'approval-settled',
        status: 'approved',
        approver: 'requester',
        decidedVia: 'remembered',
        remember: true,
      }),
    );
  });

  it('does not remember an approval that did not ask to be', async () => {
    const h = await harness();
    await run(h);
    const second = await run(h, { runId: 'run-2' });
    expect(second.awaited).toHaveLength(1);
  });

  it('does not carry a remembered approval into another thread', async () => {
    const h = await harness();
    await run(h, { decide: () => ({ approved: true, remember: true }) });
    const other = await h.store.createThread({ actor: ACTOR });
    const second = await run({ store: h.store, threadId: other.id }, { runId: 'run-2' });
    expect(second.awaited).toHaveLength(1);
  });
});

describe('approvals v2 — runs claimed before approval policies', () => {
  it('waits on the requester with no timeout and streams no approval frames', async () => {
    const h = await harness();
    // What a journal written by the previous release returns from `persist:toolcall`: the kind, and
    // nothing about approval.
    const { events, awaited } = await run(h, {
      decide: () => ({ approved: true, remember: true }),
      step: async (name, fn) => {
        const output = await fn();
        return (name.startsWith('persist:toolcall:') ? { kind: 'action' } : output) as never;
      },
    });

    expect(awaited).toEqual([{ id: 'call-0-purgeCache', opts: undefined }]);
    expect(events.some((event) => event.kind === 'approval-settled')).toBe(false);
    expect(h.store.toolCallRows()[0]).toMatchObject({ status: 'executed', remember: true });
  });
});

describe('action preflight in the approval loop', () => {
  function checked(check: (phase: 'prepare' | 'execute') => ToolPreflightResult) {
    const reg = new ToolRegistry();
    let writes = 0;
    const phases: string[] = [];
    reg.register(
      {
        name: 'purgeCache',
        kind: 'action',
        description: 'purge',
        inputSchema: z.object({ key: z.string() }),
      },
      {
        preflight: (_input, _ctx, { phase }) => {
          phases.push(phase);
          return check(phase);
        },
        execute: async () => {
          writes++;
          return 'changed';
        },
      },
    );
    return { reg, phases, writes: () => writes };
  }
  it.each(['denied', 'completed'] as const)(
    'does not request approval or execute when preparation is %s',
    async (status) => {
      const h = await harness();
      const tool = checked(() =>
        status === 'denied'
          ? { status, reason: 'locked by owner' }
          : { status, output: 'existing' },
      );
      const result = await run(h, { registry: tool.reg });
      expect(result.awaited).toEqual([]);
      expect(result.events.some((event) => event.kind === 'approval-requested')).toBe(false);
      expect(tool.writes()).toBe(0);
      expect(tool.phases).toEqual(['prepare']);
      const outcome = result.messages.at(-1)?.flatMap((message) => message.toolResults ?? [])[0];
      expect(outcome?.output).toEqual(
        status === 'completed' ? 'existing' : { rejected: true, reason: 'locked by owner' },
      );
      expect(outcome?.denied).toBe(status === 'denied' ? true : undefined);
      if (status === 'denied') expect(outcome?.error).not.toContain('person');
    },
  );
  it('rechecks domain state after a person approves and does not write', async () => {
    const h = await harness();
    const tool = checked((phase) =>
      phase === 'prepare' ? { status: 'ready' } : { status: 'denied', reason: 'state changed' },
    );
    const result = await run(h, { registry: tool.reg });
    expect(result.awaited).toHaveLength(1);
    expect(tool.phases).toEqual(['prepare', 'execute']);
    expect(tool.writes()).toBe(0);
    expect(
      (await h.store.getThread(h.threadId))?.messages.flatMap(
        (message) => message.approvals ?? [],
      )[0]?.status,
    ).toBe('approved');
    expect(result.events).toContainEqual({
      kind: 'tool-output-denied',
      id: 'call-0-purgeCache',
      reason: 'state changed',
    });
  });
  it('journals an execution denial so replay cannot rerun it after state changes', async () => {
    const h = await harness();
    let deny = true;
    const tool = checked((phase) =>
      phase === 'execute' && deny ? { status: 'denied', reason: 'locked' } : { status: 'ready' },
    );
    const journal = new Map<string, unknown>();
    const step: AgentLoopHooks['step'] = async (name, fn) => {
      if (journal.has(name)) return structuredClone(journal.get(name)) as never;
      const result = await fn();
      journal.set(name, structuredClone(result));
      return result;
    };
    await run(h, { registry: tool.reg, step });
    deny = false;
    await run(h, { registry: tool.reg, step });
    expect(tool.writes()).toBe(0);
    expect(tool.phases).toEqual(['prepare', 'execute']);
    expect(journal.has('tool:call-0-purgeCache')).toBe(true);
  });
  it('holds execution to an agent allow-list narrowed while approval was pending', async () => {
    const h = await harness();
    const allowed = ['purgeCache'];
    const tool = checked(() => ({ status: 'ready' }));
    const result = await run(h, {
      registry: tool.reg,
      toolAllowList: allowed,
      decide: () => {
        allowed.splice(0);
        return { approved: true };
      },
    });
    expect(tool.writes()).toBe(0);
    expect(tool.phases).toEqual(['prepare']);
    expect(result.events.some((event) => event.kind === 'tool-output-error')).toBe(true);
  });
  it('ends a terminal action turn when preparation returns its existing output', async () => {
    const h = await harness();
    const reg = new ToolRegistry();
    reg.register(
      {
        name: 'purgeCache',
        kind: 'action',
        description: 'purge',
        terminal: true,
        inputSchema: z.object({ key: z.string() }),
      },
      {
        preflight: () => ({ status: 'completed', output: 'existing' }),
        execute: async () => {
          throw new Error('must not execute');
        },
      },
    );
    const result = await run(h, { registry: reg });
    expect(result.awaited).toEqual([]);
    expect(result.messages).toHaveLength(1);
  });
  it.each([false, true])(
    'never retries a denied state even with transient wording (custom classifier %s)',
    async (custom) => {
      const h = await harness();
      let attempts = 0;
      const tool = checked((phase) =>
        phase === 'prepare' || ++attempts > 1
          ? { status: 'ready' }
          : { status: 'denied', reason: 'Previous deadlock requires manual review' },
      );
      await run(h, {
        registry: tool.reg,
        toolTransientRetry: {
          attempts: 2,
          backoffMs: 0,
          ...(custom ? { classify: () => true } : {}),
        },
      });
      expect(tool.writes()).toBe(0);
      expect(attempts).toBe(1);
    },
  );
  it.each(['executed', 'completed'] as const)(
    'keeps a reserved-looking %s output as user data',
    async (mode) => {
      const h = await harness();
      const output = {
        '@@nestjs-agent/tool-step-ui': 1,
        output: 'data',
        ui: [],
        preflightDenied: 'not a refusal',
      };
      const reg = new ToolRegistry();
      reg.register(
        {
          name: 'purgeCache',
          kind: 'action',
          description: 'purge',
          inputSchema: z.object({ key: z.string() }),
        },
        {
          preflight: (_input, _ctx, { phase }) =>
            phase === 'execute' && mode === 'completed'
              ? { status: 'completed', output }
              : { status: 'ready' },
          execute: async () => output,
        },
      );
      const result = await run(h, { registry: reg });
      const settled = result.messages.at(-1)?.flatMap((message) => message.toolResults ?? [])[0];
      expect(settled?.output).toEqual(output);
      expect(settled?.denied).toBeUndefined();
    },
  );
  it('checks both phases for automatic approvals', async () => {
    const h = await harness();
    const tool = checked(() => ({ status: 'ready' }));
    const result = await run(h, {
      registry: tool.reg,
      policy: { requirementFor: () => ({ required: false, approver: 'requester' }) },
    });
    expect(result.awaited).toEqual([]);
    expect(tool.phases).toEqual(['prepare', 'execute']);
    expect(tool.writes()).toBe(1);
  });
  it('still prepares remembered approvals', async () => {
    const h = await harness();
    await run(h, { decide: () => ({ approved: true, remember: true }) });
    const tool = checked(() => ({ status: 'denied', reason: 'locked' }));
    const result = await run(h, { runId: 'run-2', registry: tool.reg });
    expect(result.awaited).toEqual([]);
    expect(tool.phases).toEqual(['prepare']);
    expect(tool.writes()).toBe(0);
  });
  it('persists and streams resolved confirmation from preparation', async () => {
    const h = await harness();
    const confirmation = {
      title: 'Remove 3 linked sessions?',
      verb: 'Remove',
      detail: 'Literal {braces} survive',
    };
    const tool = checked(() => ({ status: 'ready', confirmation }));
    const result = await run(h, { registry: tool.reg });
    expect(result.events).toContainEqual({
      kind: 'approval-requested',
      id: 'call-0-purgeCache',
      approver: 'requester',
      confirmation,
    });
    const detail = await h.store.getThread(h.threadId);
    expect(detail?.messages.flatMap((message) => message.approvals ?? [])[0]?.confirmation).toEqual(
      confirmation,
    );
  });
  it('records a preparation exception as a failed result without asking', async () => {
    const h = await harness();
    const tool = checked(() => {
      throw new Error('domain unavailable');
    });
    const result = await run(h, { registry: tool.reg });
    expect(result.awaited).toEqual([]);
    expect(tool.writes()).toBe(0);
    expect(result.events).toContainEqual({
      kind: 'tool-output-error',
      id: 'call-0-purgeCache',
      error: 'domain unavailable',
    });
  });
});
