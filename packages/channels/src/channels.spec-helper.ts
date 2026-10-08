import {
  AgentStreamError,
  type AgentStreamEvent,
  type ChannelStore,
  InMemoryChannelStore,
  encodeStreamEvent,
} from '@dudousxd/nestjs-agent-core';
import type { ChannelWorkflowEngine } from './executor.js';
import { ChannelHandler, type ChannelOptions, type ChannelTurnService } from './handler.js';
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelRequest,
  InboundMessage,
  OutboundMessage,
} from './types.js';

/** Fakes for the channel handler specs: a request, an adapter that records, a scripted service. */

export function request(
  body: unknown,
  opts: { headers?: Record<string, string>; method?: string } = {},
): ChannelRequest {
  const headers: Record<string, string> = { 'x-ok': '1', ...opts.headers };
  return {
    method: opts.method ?? 'POST',
    url: '/channels/test',
    header: (name) => headers[name.toLowerCase()],
    params: {},
    body,
    rawBody: JSON.stringify(body),
  };
}

export function fakeAdapter(capabilities: Partial<ChannelCapabilities> = {}) {
  const outbox: { conversation: string; message: OutboundMessage }[] = [];
  const adapter: ChannelAdapter = {
    name: 'test',
    capabilities: { markdown: 'whatsapp', maxLength: 4096, ...capabilities },
    verify: (incoming) => incoming.header('x-ok') === '1',
    parse: (body) => body as InboundMessage,
    send: async (conversation, message) => {
      outbox.push({ conversation, message });
    },
  };
  return { adapter, outbox };
}

export const inbound = (text: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({
  id: `m-${Math.random()}`,
  from: '5511999990000',
  conversation: 'chat-1',
  text,
  raw: {},
  ...extra,
});

/** A frame the scripted run streams; `{ kind: 'fail' }` ends it the way a failed run does. */
export type ScriptedFrame = AgentStreamEvent | { kind: 'fail'; code: string; message: string };

type Recorded = any;

export interface FakeService extends ChannelTurnService {
  sends: Recorded[];
  decided: Recorded[];
  skipped: Recorded[];
  answered: Recorded[];
  subscribed: string[];
  cancelled: string[];
}

/** The run's frames as the sink carries them: NDJSON bytes, a failure thrown at the end. */
async function* encoded(frames: AsyncIterable<ScriptedFrame>): AsyncGenerator<Uint8Array> {
  for await (const frame of frames) {
    if (frame.kind === 'fail') throw new AgentStreamError(frame);
    yield encodeStreamEvent(frame);
  }
}

export function fakeService(
  frames: ScriptedFrame[] | ((runId: string) => AsyncIterable<ScriptedFrame>),
  overrides: Partial<Record<keyof ChannelTurnService, unknown>> = {},
): FakeService {
  const service = {
    sends: [],
    decided: [],
    skipped: [],
    answered: [],
    subscribed: [],
    cancelled: [],
    send: async (params: { threadId?: string }) => {
      service.sends.push(params);
      // Every turn its own run, as the agent does: `run-1`, `run-2`…
      return { runId: `run-${service.sends.length}`, threadId: params.threadId ?? 'thread-new' };
    },
    subscribe: (runId: string) => {
      service.subscribed.push(runId);
      if (typeof frames === 'function') return encoded(frames(runId));
      return encoded(
        (async function* () {
          yield* frames;
        })(),
      );
    },
    skip: async (actor: unknown, toolCallId: string, opts: unknown) => {
      service.skipped.push({ actor, toolCallId, ...(opts as object) });
    },
    cancel: async (_actor: unknown, runId: string) => {
      service.cancelled.push(runId);
    },
    actionProposalReply: (result: { status: string }, decision: string) =>
      result.status === 'applied' ? `${decision}!` : `could not: ${result.status}`,
    ...overrides,
  } as unknown as FakeService;
  return service;
}

/** A handler over `service` with sensible defaults for the specs. */
export function channel(
  adapter: ChannelAdapter,
  service: ChannelTurnService,
  options: Partial<Omit<ChannelOptions, 'adapter'>> & {
    store?: ChannelStore;
    engine?: ChannelWorkflowEngine;
  } = {},
): ChannelHandler {
  const { store, engine, ...rest } = options;
  return new ChannelHandler(
    { actor: () => actor, thread: () => 't', ...rest, adapter },
    service,
    store ?? new InMemoryChannelStore(),
    undefined,
    engine,
  );
}

export const texts = (outbox: { message: OutboundMessage }[]) =>
  outbox.map((item) => item.message.text);

export const actor = { id: 'u1', roles: [] };

/** Wait until `check` holds (the handler works after the 200). */
export async function until(check: () => boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
