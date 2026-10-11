import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AGENT_SERVICE, AgentModule, type AgentModuleOptions } from '@dudousxd/nestjs-agent';
import {
  AGENT_TOOL_REGISTRY,
  InMemoryPoppyStore,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  type PoppyEvent,
  type PoppyStore,
  type ToolRegistry,
  encodeStreamEvent,
} from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Test } from '@nestjs/testing';
import { expect } from 'vitest';
import type { PersonalAgentTurnService } from '../turn.js';
import type { PoppyAuthenticate } from './auth.js';
import { PoppyConversations, type PoppyConversationsOptions } from './conversations.js';
import { createPoppyHandler, nodeExchange } from './handler.js';

export const CLIENT = 'https://pa.example';

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the resolver was last asked: the request and the options. */
export const seen: { request: Parameters<PoppyAuthenticate>[0] | null; options: unknown } = {
  request: null,
  options: undefined,
};

/**
 * `DPoP <user>|<scopes,comma>|<in|out>|<account>[|<toActor id>]` — anything else is
 * `invalid_token`; user `forbidden` is an `insufficient_scope` refusal, `nonce` a `use_dpop_nonce`.
 */
export const fakeResolver: PoppyAuthenticate = async (request, options) => {
  seen.request = request;
  seen.options = options;
  const header = request.headers.authorization;
  const match = /^DPoP (.+)$/.exec(typeof header === 'string' ? header : '');
  if (!match?.[1]) {
    return {
      ok: false,
      status: 401,
      error: 'invalid_token',
      wwwAuthenticate: 'DPoP error="invalid_token"',
    };
  }
  const [user = '', scopes = '', state = 'out', account, toActor] = match[1].split('|');
  if (user === 'forbidden') {
    return {
      ok: false,
      status: 403,
      error: 'insufficient_scope',
      scope: 'poppy:read',
      wwwAuthenticate: 'DPoP error="insufficient_scope", scope="poppy:read"',
    };
  }
  if (user === 'nonce') {
    return {
      ok: false,
      status: 401,
      error: 'use_dpop_nonce',
      description: 'Use the DPoP nonce',
      wwwAuthenticate: 'DPoP error="use_dpop_nonce"',
      headers: { 'DPoP-Nonce': 'n-123' },
    };
  }
  const signedIn = state === 'in';
  return {
    ok: true,
    principal: {
      userId: user,
      accountId: signedIn ? (account ?? null) : null,
      clientId: CLIENT,
      scopes: scopes === '' ? [] : scopes.split(','),
      sessionId: 's1',
      signedIn,
      resource: null,
      tokenType: 'DPoP',
      ...(toActor ? { actor: { id: toActor, roles: ['USER'] } } : {}),
    },
  };
};

export type Turn = {
  chunks?: string[];
  text?: string;
  toolCall?: { name: string; input: unknown };
};
export type Script = (args: ModelTurnArgs, turnIndex: number) => Turn | Promise<Turn>;

let callIds = 0;

/** A model that streams its text in pieces, so a reader sees several deltas. */
export class ChunkedModel implements ModelProvider {
  calls: ModelTurnArgs[] = [];
  constructor(private readonly script: Script) {}
  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    this.calls.push(args);
    const turnIndex = args.messages.filter((m) => m.role === 'assistant').length;
    const turn = await this.script(args, turnIndex);
    const chunks = turn.chunks ?? (turn.text !== undefined ? [turn.text] : []);
    for (const chunk of chunks) {
      await args.sink.write(encodeStreamEvent({ kind: 'text', text: chunk }));
      if (chunks.length > 1) await sleep(15);
    }
    // Tool call ids are the stores' primary key across every thread: never reuse one.
    const call = turn.toolCall ? { id: `call-${++callIds}`, ...turn.toolCall } : undefined;
    if (call !== undefined) {
      // A real provider (`aiSdkModel`) announces each call on the stream as the model writes it —
      // what a reader (the personal-agent turn) names a refused or parked call by.
      await args.sink.write(
        encodeStreamEvent({
          kind: 'tool-input-available',
          id: call.id,
          name: call.name,
          input: call.input,
          toolKind: 'read',
        }),
      );
    }
    return {
      text: chunks.join(''),
      toolCalls: call !== undefined ? [call] : [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

export interface Agent {
  service: PersonalAgentTurnService;
  registry: ToolRegistry;
  model: ChunkedModel;
  close(): Promise<void>;
}

/** `AgentModule` over a scripted model — what answers the turns. */
export async function buildAgent(
  script: Script,
  options: Partial<AgentModuleOptions> = {},
): Promise<Agent> {
  const model = new ChunkedModel(script);
  const moduleRef = await Test.createTestingModule({
    imports: [AgentModule.forRoot({ model, store: new InMemoryAgentStore(), ...options })],
  }).compile();
  await moduleRef.init();
  return {
    service: moduleRef.get<PersonalAgentTurnService>(AGENT_SERVICE),
    registry: moduleRef.get<ToolRegistry>(AGENT_TOOL_REGISTRY),
    model,
    close: () => moduleRef.close(),
  };
}

export interface Harness {
  url: string;
  conversations: PoppyConversations;
  store: PoppyStore;
  close(): Promise<void>;
}

/** `PoppyConversations` and its handler on a bare Node server — the framework-free surface. */
export async function serve(
  options: Omit<PoppyConversationsOptions, 'store'> & { store?: PoppyStore },
  handler: { authenticate?: PoppyAuthenticate } = {},
): Promise<Harness> {
  const store = options.store ?? new InMemoryPoppyStore();
  const conversations = new PoppyConversations({ pollMs: 50, ...options, store });
  const handle = createPoppyHandler({
    path: 'poppy/conversations',
    conversations,
    keepAliveMs: 60_000,
    ...handler,
  });
  let server: Server | undefined;
  const url = await new Promise<string>((resolve) => {
    const created = createServer((req, res) => {
      const origin = `http://${req.headers.host}`;
      void handle(nodeExchange(req, res, { origin })).then((handled) => {
        if (!handled) {
          res.writeHead(418);
          res.end();
        }
      });
    });
    server = created;
    created.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(created.address() as AddressInfo).port}`);
    });
  });
  return {
    url,
    conversations,
    store,
    close: async () => {
      conversations.shutdown();
      server?.closeAllConnections();
      await new Promise((resolve) => server?.close(resolve));
    },
  };
}

export const auth = (token: string) => ({ authorization: `DPoP ${token}` });
export const U1 = auth('u1||out');

export interface Response {
  status: number;
  headers: Headers;
  body: any;
}

export async function post(
  h: { url: string },
  path: string,
  body: unknown,
  headers: Record<string, string> = U1,
): Promise<Response> {
  const res = await fetch(`${h.url}/poppy/conversations${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

export async function get(
  h: { url: string },
  path: string,
  headers: Record<string, string> = U1,
): Promise<Response> {
  const res = await fetch(`${h.url}/poppy/conversations${path}`, { headers });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

let messageIds = 0;
export const msg = (text: string, extra: Record<string, unknown> = {}) => ({
  message: { id: `msg_${++messageIds}`, sender: 'agent', text, ...extra },
});

/** Read events until `until` holds over everything read so far. */
export async function readUntil(
  h: { url: string },
  id: string,
  until: (events: PoppyEvent[]) => boolean,
  headers: Record<string, string> = U1,
  timeoutMs = 4000,
): Promise<{ events: PoppyEvent[]; last: Record<string, unknown> }> {
  const events: PoppyEvent[] = [];
  let cursor: string | null = null;
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const res = await get(h, `/${id}/events?wait=1${cursor ? `&cursor=${cursor}` : ''}`, headers);
    expect(res.status).toBe(200);
    last = res.body;
    events.push(...res.body.events);
    cursor = res.body.cursor;
    if (until(events)) return { events, last };
  }
  throw new Error(`timed out; events: ${JSON.stringify(events)}`);
}

export type CompanyMessage = PoppyEvent & {
  message: { id: string; text?: string; data?: any; sender: string };
};

export const companyMessages = (events: PoppyEvent[]) =>
  events.filter(
    (e) => e.type === 'message' && (e.message as { role: string }).role === 'company',
  ) as CompanyMessage[];

export const settled = (events: PoppyEvent[]) =>
  events.some((e) => e.type === 'state' && e.status === 'idle');

export interface SseItem {
  id?: string;
  event?: string;
  data: any;
}

/** Open an SSE read of a conversation's events and collect what it sends. */
export async function openSse(
  h: { url: string },
  id: string,
  headers: Record<string, string> = {},
) {
  const controller = new AbortController();
  const res = await fetch(`${h.url}/poppy/conversations/${id}/events`, {
    headers: { ...U1, accept: 'text/event-stream', ...headers },
    signal: controller.signal,
  });
  const items: SseItem[] = [];
  const body = res.body;
  if (body === null) throw new Error('no stream');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  const pump = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let index = buffer.indexOf('\n\n');
        while (index !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const item: Partial<SseItem> = {};
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) item.id = line.slice(4);
            else if (line.startsWith('event: ')) item.event = line.slice(7);
            else if (line.startsWith('data: ')) item.data = JSON.parse(line.slice(6));
          }
          if (item.data !== undefined) items.push(item as SseItem);
          index = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // aborted
    } finally {
      done = true;
    }
  })();
  return {
    res,
    items,
    get done() {
      return done;
    },
    async until(predicate: (items: SseItem[]) => boolean, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(items)) {
        if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(items)}`);
        await sleep(10);
      }
    },
    async close() {
      controller.abort();
      await pump;
    },
  };
}

/** An NDJSON stream of `events`, as `AgentService.subscribe` answers. */
export async function* ndjson(events: unknown[]): AsyncGenerator<Uint8Array> {
  for (const event of events) yield encodeStreamEvent(event as never);
}
