import { A2uiMessageSchema } from '@a2ui/web_core/v0_9';
import { HttpAgent } from '@ag-ui/client';
import type { BaseEvent } from '@ag-ui/core';
import {
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  encodeStreamEvent,
} from '@dudousxd/nestjs-agent-core';
import { encodeInterruptId } from '@dudousxd/nestjs-agent-core/ag-ui';
import { defineCatalog } from '@dudousxd/nestjs-agent-core/genui';
import { Card, KpiCards } from '@dudousxd/nestjs-agent-core/genui/builtins';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agUiAdapter } from '../ag-ui/ag-ui.adapter.js';
import { assertConforms } from '../ag-ui/conformance.spec-helper.js';
import { AgentModule } from '../agent.module.js';
import type { AgentModuleOptions } from '../agent.options.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';
import { AgentGenuiModule } from '../genui/agent-genui.module.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';
import { a2uiAdapter } from './a2ui.adapter.js';

/**
 * `POST /agent/a2ui` over real HTTP: a JSON Lines stream of A2UI v0.9 messages (checked against the
 * official schema of `@a2ui/web_core`), actions in, approvals decided by an A2UI button. And the
 * AG-UI route with `a2ui: true`, read by AG-UI's own client. Mirrors `adonis-agent`'s
 * `a2ui-route.spec.ts`.
 */

interface ScriptedTurn {
  text: string;
  toolCall?: { name: string; input: unknown };
}
type Script = (args: ModelTurnArgs, turn: number) => ScriptedTurn;

/** A model that streams what a real adapter streams: text and tool announcements as events. */
class EventModel implements ModelProvider {
  constructor(private readonly script: Script) {}

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const turn = args.messages.filter((message) => message.role === 'assistant').length;
    const scripted = this.script(args, turn);
    if (scripted.text.length > 0) {
      await args.sink.write(encodeStreamEvent({ kind: 'text', text: scripted.text }));
    }
    const toolCalls =
      scripted.toolCall !== undefined
        ? [
            {
              id: `call-${turn}-${scripted.toolCall.name}`,
              name: scripted.toolCall.name,
              input: scripted.toolCall.input,
            },
          ]
        : [];
    for (const call of toolCalls) {
      const toolKind = call.name === 'refund' ? 'action' : 'read';
      await args.sink.write(encodeStreamEvent({ kind: 'tool-input-available', ...call, toolKind }));
    }
    return {
      text: scripted.text,
      toolCalls,
      usage: { inputTokens: args.messages.length, outputTokens: scripted.text.length },
      modelId: 'fake-model',
    };
  }
}

@AiTool({
  name: 'refund',
  kind: 'action',
  description: 'refund an order',
  input: z.object({ id: z.number() }),
})
@Injectable()
class RefundTool {
  async execute() {
    return { refunded: true };
  }
}

const catalog = defineCatalog([Card, KpiCards]);
const tree = {
  type: 'Card',
  props: { title: 'Sales' },
  children: [{ type: 'KpiCards', props: { items: [{ label: 'Revenue', value: '$9k' }] } }],
};

/** The last user message, as the model sees it. */
function lastUser(args: ModelTurnArgs): string {
  const user = [...args.messages].reverse().find((message) => message.role === 'user');
  const content = (user as { content?: unknown } | undefined)?.content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

let app: NestExpressApplication | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function boot(
  script: Script,
  genui: Parameters<typeof AgentGenuiModule.forRoot>[0] = { catalog },
  extra: Partial<AgentModuleOptions> = {},
): Promise<string> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new EventModel(script),
        store: new InMemoryAgentStore(),
        actorResolver: new HeaderActorResolver(),
        followUps: false,
        adapters: [a2uiAdapter({ quietMs: 80 }), agUiAdapter({ quietMs: 80, a2ui: true })],
        ...extra,
      }),
      AgentGenuiModule.forRoot(genui),
    ],
    providers: [RefundTool],
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  await app.listen(0, '127.0.0.1');
  return (await app.getUrl()).replace('[::1]', '127.0.0.1');
}

async function a2ui(url: string, body: unknown, actor = 'u1') {
  const response = await fetch(`${url}/agent/a2ui`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-actor-id': actor },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  const messages =
    response.status === 200
      ? raw
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as Record<string, Record<string, unknown>>)
      : [];
  for (const message of messages) {
    const result = A2uiMessageSchema.safeParse(message);
    if (!result.success) throw new Error(`invalid A2UI message: ${JSON.stringify(message)}`);
  }
  return { response, messages, raw };
}

describe('a2uiAdapter()', () => {
  it('streams a turn as A2UI JSON Lines: the UI as a surface, the text as a bound one', async () => {
    const url = await boot((_args, turn) =>
      turn === 0
        ? { text: '', toolCall: { name: 'ui__render', input: tree } }
        : { text: 'There you go.' },
    );
    const { response, messages } = await a2ui(url, { message: 'dashboard please' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/jsonl');
    expect(response.headers.get('x-agent-thread-id')).toBeTruthy();
    expect(response.headers.get('x-agent-run-id')).toBeTruthy();
    const ui = messages.filter(
      (message) =>
        (message.createSurface ?? message.updateComponents)?.surfaceId === 'call-0-ui__render:ui:0',
    );
    expect(ui.map((message) => Object.keys(message)[1])).toEqual([
      'createSurface',
      'updateComponents',
    ]);
    const components = ui[1]?.updateComponents?.components as { id: string; component: string }[];
    expect(components[0]).toMatchObject({ id: 'root', component: 'Card' });
    expect(JSON.stringify(components)).toContain('Revenue');
    const text = messages.filter((message) => message.updateDataModel !== undefined).at(-1);
    expect(text?.updateDataModel).toMatchObject({ path: '/text', value: 'There you go.' });
  });

  it('takes an A2UI action as the next turn, on the same thread', async () => {
    const url = await boot((args) => ({ text: `heard: ${lastUser(args)}` }));
    const first = await a2ui(url, { message: 'hi' });
    const threadId = first.response.headers.get('x-agent-thread-id') as string;
    const { messages } = await a2ui(url, {
      threadId,
      action: {
        version: 'v0.9',
        action: {
          name: 'refund',
          surfaceId: 's1',
          sourceComponentId: 'root.0',
          timestamp: new Date().toISOString(),
          context: { orderId: '7' },
        },
      },
    });
    const said = String(messages.filter((m) => m.updateDataModel).at(-1)?.updateDataModel?.value);
    expect(said).toContain('UI action "refund"');
    expect(said).toContain('"orderId": "7"');

    const bad = await a2ui(url, {
      action: { action: { name: 'x', context: { blob: 'y'.repeat(9000) } } },
    });
    expect(bad.response.status).toBe(400);
    expect(JSON.parse(bad.raw)).toMatchObject({ code: 'invalid_action' });
    const empty = await a2ui(url, { message: '  ' });
    expect(empty.response.status).toBe(400);
    const intruder = await a2ui(url, { threadId, message: 'mine now' }, 'u2');
    expect([403, 404]).toContain(intruder.response.status);
  });

  it('ends on an approval with Approve / Reject buttons, and the Approve action continues the run', async () => {
    const url = await boot((_args, turn) =>
      turn === 0
        ? { text: '', toolCall: { name: 'refund', input: { id: 7 } } }
        : { text: 'Refunded.' },
    );
    const first = await a2ui(url, { message: 'refund 7' });
    const buttons = first.messages
      .flatMap(
        (message) => (message.updateComponents?.components as Record<string, unknown>[]) ?? [],
      )
      .filter((component) => component.component === 'Button');
    expect(buttons).toHaveLength(2);
    const approve = buttons[0]?.action as {
      event: { name: string; context: { interruptId: string } };
    };
    expect(approve.event.name).toBe('agora.approve');

    // Someone else's approval is not theirs to decide.
    const intruder = await a2ui(
      url,
      { action: { name: 'agora.approve', context: approve.event.context } },
      'u2',
    );
    expect(intruder.response.status).toBeGreaterThanOrEqual(400);

    const second = await a2ui(url, {
      action: {
        version: 'v0.9',
        action: {
          name: 'agora.approve',
          surfaceId: 'x',
          sourceComponentId: 'approve',
          timestamp: new Date().toISOString(),
          context: approve.event.context,
        },
      },
    });
    expect(second.response.status).toBe(200);
    const said = second.messages.filter((m) => m.updateDataModel).at(-1)?.updateDataModel?.value;
    expect(said).toBe('Refunded.');
    // Decided already: the run is no longer waiting on it.
    const again = await a2ui(url, {
      action: { name: 'agora.approve', context: approve.event.context },
    });
    expect(again.response.status).toBeGreaterThanOrEqual(400);
    // An approval action without the interrupt it decides is refused.
    const blind = await a2ui(url, { action: { name: 'agora.reject', context: {} } });
    expect(blind.response.status).toBe(400);
  });
});

describe('a2uiAdapter() and independent proposals', () => {
  it('decides a proposal through the proposal service and answers with its reply', async () => {
    const store = new InMemoryAgentStore();
    const actor = { id: 'u1' };
    const thread = await store.createThread({ id: crypto.randomUUID(), actor });
    await store.createActionProposal({
      id: 'proposal-a2ui',
      threadId: thread.id,
      actorRef: actor.id,
      tenantRef: null,
      originRunId: 'finished-origin',
      originMessageId: 'origin-message',
      originToolCallId: 'origin-call',
      toolName: 'refund',
      input: { id: 11 },
      confirmation: { title: 'Refund?', verb: 'Refund' },
      approver: 'requester',
      expiresAt: null,
      idempotencyKey: 'a2ui',
    });
    let modelCalls = 0;
    const url = await boot(
      () => {
        modelCalls++;
        return { text: 'Unexpected model run' };
      },
      { catalog },
      {
        store,
        actionApprovalMode: 'independent',
        backgroundActorResolver: { resolve: async () => actor },
        actionProposalWorker: { pollIntervalMs: 60_000, leaseMs: 600_000 },
      },
    );
    const interruptId = encodeInterruptId({
      kind: 'proposal',
      parked: 'finished-origin',
      stream: 'finished-origin',
      toolCallId: 'origin-call',
      position: 4,
      proposalId: 'proposal-a2ui',
      threadId: thread.id,
    });
    // Somebody else's proposal is refused the way the native route refuses it.
    const intruder = await a2ui(
      url,
      { action: { name: 'agora.reject', context: { interruptId } } },
      'intruder',
    );
    expect(intruder.response.status).toBe(403);
    const { response, messages } = await a2ui(url, {
      action: { name: 'agora.reject', context: { interruptId } },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-agent-thread-id')).toBe(thread.id);
    expect(modelCalls).toBe(0);
    const reply = messages.filter((message) => message.updateDataModel !== undefined).at(-1);
    expect(String(reply?.updateDataModel?.value).length).toBeGreaterThan(0);
    const decided = await store.getActionProposal(
      { threadId: thread.id, actorRef: actor.id, tenantRef: null },
      'proposal-a2ui',
    );
    expect(decided?.decision).toBe('rejected');
    expect(decided?.decisionAudit?.via).toBe('a2ui');
  });
});

describe('a2uiAdapter() with AgentGenuiModule.forRoot({ sandbox: true })', () => {
  it('draws a component nothing maps (the sandbox) as its text, from the module catalog', async () => {
    const view = {
      title: 'Bill splitter',
      summary: 'Splits a bill between people.',
      html: '<button>Split</button>',
    };
    const url = await boot(
      (_args, turn) =>
        turn === 0
          ? { text: '', toolCall: { name: 'ui__render', input: { type: 'Sandbox', props: view } } }
          : { text: 'Done.' },
      { catalog, sandbox: true },
    );
    const { messages } = await a2ui(url, { message: 'split it' });
    const components = messages
      .filter((message) => message.updateComponents?.surfaceId === 'call-0-ui__render:ui:0')
      .flatMap((message) => message.updateComponents?.components as Record<string, unknown>[]);
    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({ id: 'root', component: 'Text' });
    expect(String(components[0]?.text)).toContain('Splits a bill between people.');
    expect(JSON.stringify(components)).not.toContain('<button>');
  });
});

describe('agUiAdapter({ a2ui: true })', () => {
  async function run(client: HttpAgent, parameters: Parameters<HttpAgent['runAgent']>[0] = {}) {
    const events: BaseEvent[] = [];
    await client.runAgent(parameters, { onEvent: ({ event }) => void events.push(event) });
    return events;
  }

  it('sends each ui frame as an a2ui-surface activity too, and conforms', async () => {
    const url = await boot((_args, turn) =>
      turn === 0 ? { text: '', toolCall: { name: 'ui__render', input: tree } } : { text: 'Done.' },
    );
    const client = new HttpAgent({ url: `${url}/agent/ag-ui`, headers: { 'x-actor-id': 'u1' } });
    client.addMessage({ id: 'm1', role: 'user', content: 'dashboard' });
    const events = await run(client);
    await assertConforms(events as never);
    const activity = events.find((event) => event.type === 'ACTIVITY_SNAPSHOT') as unknown as {
      activityType: string;
      content: { a2ui_operations: unknown[] };
    };
    expect(activity.activityType).toBe('a2ui-surface');
    for (const message of activity.content.a2ui_operations) {
      expect(A2uiMessageSchema.safeParse(message).success).toBe(true);
    }
  });

  it('starts a turn from forwardedProps.a2uiAction, without a new user message', async () => {
    const url = await boot((args) => ({ text: `heard: ${lastUser(args)}` }));
    const client = new HttpAgent({ url: `${url}/agent/ag-ui`, headers: { 'x-actor-id': 'u1' } });
    client.addMessage({ id: 'm1', role: 'user', content: 'hello' });
    await run(client);
    const events = await run(client, {
      forwardedProps: {
        a2uiAction: { userAction: { name: 'split', surfaceId: 's', context: { people: 3 } } },
      },
    });
    const said = events
      .filter((event) => event.type === 'TEXT_MESSAGE_CONTENT')
      .map((event) => (event as unknown as { delta: string }).delta)
      .join('');
    expect(said).toContain('UI action "split"');
    expect(said).toContain('"people": 3');
  });

  it('refuses a malformed forwardedProps.uiAction with 400 invalid_ui_action', async () => {
    const url = await boot(() => ({ text: 'never' }));
    const response = await fetch(`${url}/agent/ag-ui`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': 'u1' },
      body: JSON.stringify({
        threadId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        messages: [{ id: 'm1', role: 'user', content: 'hi' }],
        forwardedProps: { uiAction: { name: 'go', context: 'nope' } },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_ui_action' });
  });
});
