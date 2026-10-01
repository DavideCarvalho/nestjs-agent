import { HttpAgent } from '@ag-ui/client';
import type { BaseEvent, Interrupt, RunAgentInput } from '@ag-ui/core';
import {
  AGENT_ATTACHMENT_STAGING,
  type AttachmentStagingStore,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  encodeStreamEvent,
} from '@dudousxd/nestjs-agent-core';
import { type AgUiEvent, decodeInterruptId } from '@dudousxd/nestjs-agent-core/ag-ui';
import { InMemoryAgentStore, InMemoryAttachmentStagingStore } from '@dudousxd/nestjs-agent-testing';
import { type CanActivate, type DynamicModule, Global, Injectable, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from '../agent.module.js';
import type { AgentModuleOptions } from '../agent.options.js';
import { AgentService } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';
import { agUiAdapter } from './ag-ui.adapter.js';
import { assertConforms, assertInputSchema } from './conformance.spec-helper.js';

/**
 * `POST /agent/ag-ui` over real HTTP, read by the protocol's own first-party client (`HttpAgent`
 * from `@ag-ui/client`): what it accepts, how it assembles the messages, and the interrupt → resume
 * round-trip it drives. Mirrors `adonis-agent`'s `ag-ui-route.spec.ts`.
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

@Agent({ name: 'base', systemPrompt: 'Base prompt.' })
@Injectable()
class BaseAgent {}

@Agent({
  name: 'helper',
  systemPrompt: 'Helper prompt.',
  personas: [{ id: 'terse', label: 'Terse', systemPrompt: 'Answer tersely.' }],
})
@Injectable()
class PersonaAgent {}

function globalStagingModule(staging: AttachmentStagingStore): DynamicModule {
  @Global()
  @Module({
    providers: [{ provide: AGENT_ATTACHMENT_STAGING, useValue: staging }],
    exports: [AGENT_ATTACHMENT_STAGING],
  })
  class GlobalStagingModule {}
  return { module: GlobalStagingModule };
}

interface Booted {
  app: NestExpressApplication;
  url: string;
  service: AgentService;
}

let booted: Booted | null = null;

afterEach(async () => {
  await booted?.app.close();
  booted = null;
});

async function boot(
  script: Script,
  extra: Partial<AgentModuleOptions> & {
    staging?: AttachmentStagingStore;
    agents?: boolean;
  } = {},
): Promise<Booted> {
  const { staging, agents, ...options } = extra;
  const moduleRef = await Test.createTestingModule({
    imports: [
      ...(staging !== undefined ? [globalStagingModule(staging)] : []),
      AgentModule.forRoot({
        model: new EventModel(script),
        store: new InMemoryAgentStore(),
        actorResolver: new HeaderActorResolver(),
        followUps: false,
        adapters: [agUiAdapter({ quietMs: 80 })],
        ...options,
      }),
    ],
    providers: [RefundTool, ...(agents === true ? [BaseAgent, PersonaAgent] : [])],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  booted = { app, url: url.replace('[::1]', '127.0.0.1'), service: app.get(AgentService) };
  return booted;
}

function agent(url: string, actor = 'u1', threadId = crypto.randomUUID()): HttpAgent {
  return new HttpAgent({ url: `${url}/agent/ag-ui`, headers: { 'x-actor-id': actor }, threadId });
}

/** Run the agent once, keeping every event the client accepted. */
async function run(
  client: HttpAgent,
  text: string | null,
  parameters: Parameters<HttpAgent['runAgent']>[0] = {},
): Promise<{ events: AgUiEvent[]; interrupts: Interrupt[] }> {
  if (text !== null) client.addMessage({ id: crypto.randomUUID(), role: 'user', content: text });
  const events: BaseEvent[] = [];
  await client.runAgent(parameters, { onEvent: ({ event }) => void events.push(event) });
  const finished = events.find((event) => event.type === 'RUN_FINISHED') as
    | { outcome?: { type: string; interrupts?: Interrupt[] } }
    | undefined;
  return {
    events: events as unknown as AgUiEvent[],
    interrupts: finished?.outcome?.interrupts ?? [],
  };
}

function post(url: string, body: unknown, actor: string | null = 'u1'): Promise<Response> {
  return fetch(`${url}/agent/ag-ui`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(actor !== null ? { 'x-actor-id': actor } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function readEvents(response: Response): Promise<AgUiEvent[]> {
  const text = await response.text();
  return text
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as AgUiEvent);
}

function input(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    protocolVersion: '1.0',
    messages: [{ id: 'm1', role: 'user', content: 'hi' }],
    ...overrides,
  } as RunAgentInput;
}

const refundScript: Script = (_args, turn) =>
  turn === 0 ? { text: '', toolCall: { name: 'refund', input: { id: 7 } } } : { text: 'Done.' };

describe('POST /agent/ag-ui', () => {
  it('mounts where the adapter says', async () => {
    const { url } = await boot(() => ({ text: 'hi' }), {
      adapters: [agUiAdapter({ path: 'copilot' })],
    });
    expect((await post(url, input())).status).toBe(404);
    const response = await fetch(`${url}/agent/copilot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': 'u1' },
      body: JSON.stringify(input()),
    });
    expect(response.status).toBe(200);
    await readEvents(response);
  });

  it('is behind the module guards, and not mounted on an engine-only surface', async () => {
    @Injectable()
    class DenyAll implements CanActivate {
      canActivate(): boolean {
        return false;
      }
    }
    const guarded = await boot(() => ({ text: 'hi' }), { guards: [DenyAll] });
    expect((await post(guarded.url, input())).status).toBe(403);
    await guarded.app.close();
    booted = null;
    const engine = await boot(() => ({ text: 'hi' }), { surface: 'engine' });
    expect((await post(engine.url, input())).status).toBe(404);
  });

  it('is not mounted unless the module asks for it', async () => {
    const { url } = await boot(() => ({ text: 'hi' }), { adapters: [] });
    expect((await post(url, input())).status).toBe(404);
  });

  it('answers a run the first-party client accepts and assembles, with per-model usage', async () => {
    const { url } = await boot(() => ({ text: 'Hello there' }));
    const client = agent(url);
    const { events } = await run(client, 'hi');
    await assertConforms(events);
    expect(events[0]).toMatchObject({
      type: 'RUN_STARTED',
      threadId: client.threadId,
      protocolVersion: '1.0',
    });
    expect(events.at(-1)).toMatchObject({
      type: 'RUN_FINISHED',
      threadId: client.threadId,
      usage: [{ model: 'fake-model' }],
    });
    expect(events.at(-1)).not.toHaveProperty('outcome');
    expect(client.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'Hello there'],
    ]);
  });

  it('runs the agent and persona the consumer forwarded', async () => {
    const prompts: string[] = [];
    const { url, service } = await boot(
      (args) => {
        prompts.push(args.system);
        return { text: 'ok' };
      },
      { agents: true, defaultAgent: 'base' },
    );
    const client = agent(url);
    await run(client, 'hi', { forwardedProps: { agent: 'helper', persona: 'terse' } });
    expect(prompts[0]).toBe('Answer tersely.');
    const thread = await service.getThread({ id: 'u1' }, client.threadId);
    expect(thread?.persona).toBe('terse');
    expect(thread?.messages.map((message) => [message.agentName, message.persona])).toEqual([
      [undefined, 'terse'],
      ['helper', 'terse'],
    ]);
  });

  it('continues the thread the consumer named, and keeps it to its owner', async () => {
    const seen: number[] = [];
    const { url, service } = await boot((args) => {
      seen.push(args.messages.length);
      return { text: 'ok' };
    });
    const client = agent(url);
    await run(client, 'first');
    await run(client, 'second');
    // the second turn ran on the stored history of the SAME thread
    expect(seen[1]).toBeGreaterThan(seen[0] as number);
    expect(await service.threadOwner(client.threadId)).toBe('u1');
    expect((await service.listThreads('u1')).map((thread) => thread.id)).toEqual([client.threadId]);

    const intruder = await post(url, input({ threadId: client.threadId }), 'u2');
    expect([403, 404]).toContain(intruder.status);
  });

  it('ends on an approval with the interrupt outcome, and a resume approves it', async () => {
    const { url } = await boot(refundScript);
    const client = agent(url);
    const first = await run(client, 'refund 7');
    await assertConforms(first.events);
    expect(first.interrupts).toHaveLength(1);
    const interrupt = first.interrupts[0] as Interrupt;
    expect(interrupt).toMatchObject({
      reason: 'tool_approval',
      toolCallId: 'call-0-refund',
      metadata: { 'agora.toolName': 'refund', 'agora.input': { id: 7 } },
    });
    expect(first.events.some((event) => event.type === 'TOOL_CALL_RESULT')).toBe(false);

    const second = await run(client, null, {
      resume: [{ interruptId: interrupt.id, status: 'resolved', payload: { approved: true } }],
    });
    await assertConforms(second.events);
    expect(second.interrupts).toEqual([]);
    expect(second.events).toContainEqual(
      expect.objectContaining({
        type: 'TOOL_CALL_RESULT',
        toolCallId: 'call-0-refund',
        content: '{"refunded":true}',
      }),
    );
    expect(client.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Done.' });
    // usage follows the run boundary: the resumed run reports only its own model call
    const usage = (second.events.at(-1) as { usage?: { inputTokens?: number }[] }).usage;
    expect(usage).toHaveLength(1);
  });

  it('a resume that declines feeds the refusal back to the model', async () => {
    const seen: string[] = [];
    const { url } = await boot((args, turn) => {
      if (turn === 0) return { text: '', toolCall: { name: 'refund', input: { id: 7 } } };
      seen.push(JSON.stringify(args.messages));
      return { text: 'Understood.' };
    });
    const client = agent(url);
    const first = await run(client, 'refund 7');
    const id = (first.interrupts[0] as Interrupt).id;
    const second = await run(client, null, {
      resume: [
        {
          interruptId: id,
          status: 'resolved',
          payload: { approved: false, reason: 'wrong order' },
        },
      ],
    });
    await assertConforms(second.events);
    const result = second.events.find((event) => event.type === 'TOOL_CALL_RESULT');
    expect(result).toMatchObject({ metadata: { 'agora.outcome': 'denied' } });
    expect(seen[0]).toContain('wrong order');
    expect(client.messages.at(-1)).toMatchObject({ content: 'Understood.' });
  });

  it('only the owner of the interrupted run may resume it, and only while it waits', async () => {
    const { url } = await boot(refundScript);
    const client = agent(url);
    const first = await run(client, 'refund 7');
    const id = (first.interrupts[0] as Interrupt).id;
    const resume = [{ interruptId: id, status: 'resolved' as const, payload: true }];

    const intruder = await post(url, input({ threadId: client.threadId, resume }), 'u2');
    expect([403, 404]).toContain(intruder.status);

    const malformed = await post(
      url,
      input({
        threadId: client.threadId,
        resume: [{ interruptId: id, status: 'resolved', payload: { nope: 1 } }],
      }),
    );
    expect(malformed.status).toBe(400);

    const ok = await post(url, input({ threadId: client.threadId, resume }));
    expect(ok.status).toBe(200);
    await readEvents(ok);
    // answered already: nothing is waiting for a second answer
    const again = await post(url, input({ threadId: client.threadId, resume }));
    expect(again.status).toBe(409);
  });

  it('a resume entry for an interrupt it never raised is skipped with a warning', async () => {
    const { url } = await boot(() => ({ text: 'Hello' }));
    const response = await post(
      url,
      input({ resume: [{ interruptId: 'int-1', status: 'resolved', payload: true }] }),
    );
    expect(response.status).toBe(200);
    const events = await readEvents(response);
    await assertConforms(events);
    expect(events).toContainEqual({
      type: 'CUSTOM',
      name: 'agora.warning',
      value: { message: 'The resume entry int-1 answers an interrupt this agent did not raise.' },
    });
    expect(events.at(-1)).toMatchObject({ type: 'RUN_FINISHED' });
  });

  it('stages an inline image as an attachment and says what it could not use', async () => {
    const attachments: unknown[] = [];
    const { url } = await boot(
      (args) => {
        attachments.push(args.messages.at(-1)?.attachments);
        return { text: 'A cat.' };
      },
      { staging: new InMemoryAttachmentStagingStore() },
    );
    const body = input({
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            {
              type: 'image',
              source: {
                type: 'data',
                value: Buffer.from('png-bytes').toString('base64'),
                mimeType: 'image/png',
              },
              metadata: { filename: 'cat.png' },
            },
            { type: 'document', source: { type: 'url', value: 'https://example.com/a.pdf' } },
          ],
        },
      ],
    } as Partial<RunAgentInput>);
    assertInputSchema(body);
    const response = await post(url, body);
    expect(response.status).toBe(200);
    const events = await readEvents(response);
    await assertConforms(events);
    expect(attachments[0]).toMatchObject([{ contentType: 'image/png', name: 'cat.png' }]);
    const warnings = events.filter(
      (event) => event.type === 'CUSTOM' && event.name === 'agora.warning',
    );
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).toContain('url source');
  });

  it('refuses malformed input before any run starts', async () => {
    const { url } = await boot(() => ({ text: 'hi' }));
    expect((await post(url, { runId: 'r', messages: [] })).status).toBe(400);
    expect((await post(url, input({ messages: [] }))).status).toBe(400);
    expect(
      (await post(url, input({ resume: [{ interruptId: 'x', status: 'later' } as never] }))).status,
    ).toBe(400);
    expect((await post(url, input(), null)).status).toBe(401);
  });

  it('reports a failed run in-stream, as RUN_ERROR', async () => {
    const { url } = await boot(() => {
      throw new Error('provider exploded');
    });
    const response = await post(url, input());
    expect(response.status).toBe(200);
    const events = await readEvents(response);
    await assertConforms(events);
    expect(events.at(-1)).toMatchObject({ type: 'RUN_ERROR' });
  });

  it('mints interrupt ids that address the parked run', async () => {
    const { url } = await boot(() => ({
      text: '',
      toolCall: { name: 'refund', input: { id: 1 } },
    }));
    const { interrupts, events } = await run(agent(url), 'go');
    const custom = events.find(
      (event) => event.type === 'CUSTOM' && event.name === 'agora.run',
    ) as { value: { runId: string } };
    expect(decodeInterruptId(interrupts[0]?.id)).toMatchObject({
      kind: 'approval',
      parked: custom.value.runId,
      stream: custom.value.runId,
      toolCallId: 'call-0-refund',
    });
  });
});
