import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type PoppyAuthenticate,
  type PoppyPrincipal,
  globalPoppyAuthenticate,
  globalPoppyIssuer,
} from './auth.js';
import type { PoppyConversations } from './conversations.js';
import { PoppyError, isPoppyId, parseEmptyBody, parseSendBody } from './protocol.js';

/**
 * One HTTP exchange, framework-free: what the Poppy handler reads and writes. `nodeExchange` and
 * `expressExchange` build one; any other server can too.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec),
 * a spec still in development: this API WILL change as the spec evolves — possibly in breaking
 * ways, outside semver majors while it is a draft.
 */
export interface PoppyExchange {
  method: string;
  /** The path, without the query string. */
  path: string;
  query: Record<string, string | undefined>;
  /** The full PUBLIC URL the request was made to (with its query) — what a DPoP proof's `htu` names. */
  url: string;
  /** Lower-cased header names, repeated values joined. */
  headers: Record<string, string | undefined>;
  /** The headers as received (lower-cased names) — what the Session Token resolver verifies. */
  rawHeaders: Record<string, string | string[] | undefined>;
  /** The raw body, refused past `limit` bytes. Only called once the request is authenticated. */
  readBody(limit: number): Promise<string>;
  json(status: number, body: unknown, headers?: Record<string, string>): void;
  /** Start a `200` streamed response. */
  openStream(headers: Record<string, string>): PoppyStreamWriter;
}

/** @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec). */
export interface PoppyStreamWriter {
  write(chunk: string): void;
  end(): void;
  /** Aborts when the client goes away. */
  signal: AbortSignal;
}

/** @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec). */
export interface PoppyHandlerOptions {
  /** The endpoint path, no slashes (`'poppy/conversations'`). */
  path: string;
  conversations: PoppyConversations;
  /** Verifies Session Tokens. Omitted → the global slot, read per request. */
  authenticate?: PoppyAuthenticate;
  /** Largest accepted request body, in bytes. Default 1 MiB. */
  maxBodyBytes?: number;
  /** Cap on a read's `wait`, in seconds. Default 30. */
  maxWaitSeconds?: number;
  /** Close a stream after this long; the Personal Agent reconnects (§7.6). Default 5 minutes. */
  streamMaxMs?: number;
  /** A comment line this often keeps a stream's proxies from timing it out. Default 15 s. */
  keepAliveMs?: number;
  onError?: (error: unknown) => void;
}

type Route =
  | { kind: 'start' }
  | { kind: 'messages'; id: string }
  | { kind: 'events'; id: string }
  | { kind: 'handoff'; id: string }
  | { kind: 'close'; id: string };

/** Match the path after the endpoint: `null` → 404, a method mismatch → 405. */
function matchRoute(method: string, rest: string[]): Route | 404 | 405 {
  const allow = (expected: string, route: Route) => (method === expected ? route : 405);
  if (rest.length === 0) return allow('POST', { kind: 'start' });
  if (rest.length !== 2) return 404;
  const [id = '', action] = rest;
  switch (action) {
    case 'messages':
      return allow('POST', { kind: 'messages', id });
    case 'events':
      return allow('GET', { kind: 'events', id });
    case 'handoff':
      return allow('POST', { kind: 'handoff', id });
    case 'close':
      return allow('POST', { kind: 'close', id });
    default:
      return 404;
  }
}

/** The scheme the request authenticated with — what a challenge of ours is written in. */
function schemeOf(exchange: PoppyExchange): string {
  const header = exchange.headers.authorization ?? '';
  return /^bearer\s/i.test(header) ? 'Bearer' : 'DPoP';
}

/** `wait` in ms, capped; absent → 0. */
function waitMs(exchange: PoppyExchange, maxSeconds: number): number {
  const raw = exchange.query.wait;
  if (raw === undefined || raw === '') return 0;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new PoppyError('invalid_request', 'wait must be a non-negative number of seconds');
  }
  return Math.min(seconds, maxSeconds) * 1000;
}

function cursorOf(exchange: PoppyExchange, header = false): string | undefined {
  const raw = (header ? exchange.headers['last-event-id'] : undefined) ?? exchange.query.cursor;
  return raw === undefined || raw === '' ? undefined : raw.trim();
}

/** Whether `path` (no query) is the endpoint or under it. */
export function isPoppyPath(path: string, endpointPath: string): boolean {
  const base = `/${endpointPath.replace(/^\/+|\/+$/g, '')}`;
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === base || trimmed.startsWith(`${base}/`);
}

/**
 * The Poppy conversation endpoint (§7) — `POST {endpoint}`, `POST {endpoint}/{id}/messages`,
 * `GET {endpoint}/{id}/events` (JSON, long-poll with `wait`, or SSE), `POST …/handoff` and
 * `POST …/close`. Returns a handler that answers everything under `/{path}` and reports `false`
 * for anything else, so it can sit in front of the router.
 *
 * Every request is authenticated BEFORE its body is read, by the resolver of
 * `Symbol.for('@adonis-agora/poppy:authenticate')` or the one given. Without either the endpoint
 * answers `501`.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec),
 * a spec still in development: this API WILL change as the spec evolves — possibly in breaking
 * ways, outside semver majors while it is a draft.
 */
export function createPoppyHandler(
  options: PoppyHandlerOptions,
): (exchange: PoppyExchange) => Promise<boolean> {
  const base = `/${options.path.replace(/^\/+|\/+$/g, '')}`;
  const maxBody = options.maxBodyBytes ?? 1024 * 1024;
  const maxWait = options.maxWaitSeconds ?? 30;
  const conversations = options.conversations;

  async function authenticate(exchange: PoppyExchange): Promise<PoppyPrincipal | null> {
    const resolver = options.authenticate ?? globalPoppyAuthenticate();
    if (!resolver) {
      throw new PoppyError(
        'not_implemented',
        'Poppy conversations are not enabled: no Session Token resolver is installed',
      );
    }
    // No options: a turn's scopes are decided per tool, and the `resource` a token must carry is
    // the resolver's to derive from the URL (the `resource` of the `poppy` protocol entry, if any).
    const result = await resolver({
      method: exchange.method,
      url: exchange.url,
      headers: exchange.rawHeaders,
    });
    if (result.ok) return result.principal;
    exchange.json(
      result.status,
      {
        error: result.error,
        ...(result.description !== undefined ? { error_description: result.description } : {}),
        ...(result.scope !== undefined ? { scope: result.scope } : {}),
      },
      {
        ...(result.headers ?? {}),
        'WWW-Authenticate': result.wwwAuthenticate,
        'Cache-Control': 'no-store',
      },
    );
    return null;
  }

  async function stream(
    exchange: PoppyExchange,
    principal: PoppyPrincipal,
    id: string,
  ): Promise<void> {
    const conversation = await conversations.owned(principal, id);
    const controller = new AbortController();
    const stop = () => controller.abort();
    const iterator = conversations.stream(
      conversation,
      cursorOf(exchange, true),
      controller.signal,
    );
    let first: Awaited<ReturnType<typeof iterator.next>>;
    try {
      // The cursor is checked before the stream opens, so a bad one is still a JSON error.
      first = await iterator.next();
    } catch (error) {
      await iterator.return(undefined);
      throw error;
    }
    const writer = exchange.openStream({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    writer.signal.addEventListener('abort', stop, { once: true });
    if (writer.signal.aborted) stop();
    const maxTimer = setTimeout(stop, options.streamMaxMs ?? 300_000);
    const keepAlive = setInterval(
      () => writer.write(': keep-alive\n\n'),
      options.keepAliveMs ?? 15_000,
    );
    maxTimer.unref?.();
    keepAlive.unref?.();
    try {
      let next = first;
      while (!next.done) {
        const item = next.value;
        if (item.kind === 'event') {
          writer.write(`id: ${item.event.id}\ndata: ${JSON.stringify(item.event)}\n\n`);
        } else if (item.kind === 'delta') {
          writer.write(
            `event: text-delta\ndata: ${JSON.stringify({ message_id: item.messageId, text: item.text })}\n\n`,
          );
        }
        next = await iterator.next();
      }
    } finally {
      clearTimeout(maxTimer);
      clearInterval(keepAlive);
      await iterator.return(undefined);
      writer.end();
    }
  }

  async function route(exchange: PoppyExchange, route: Route): Promise<void> {
    const principal = await authenticate(exchange);
    if (principal === null) return;

    switch (route.kind) {
      case 'start': {
        const body = parseSendBody(await exchange.readBody(maxBody), { allowParent: true });
        const started = await conversations.start(principal, body);
        return answerPost(exchange, principal, started.conversationId, started);
      }
      case 'messages': {
        if (!isPoppyId(route.id)) throw new PoppyError('conversation_not_found');
        // The conversation is checked before the body is parsed: an unknown one is a 404.
        await conversations.owned(principal, route.id);
        const body = parseSendBody(await exchange.readBody(maxBody), { allowParent: false });
        const sent = await conversations.send(principal, route.id, body);
        return answerPost(exchange, principal, route.id, sent);
      }
      case 'events': {
        if (!isPoppyId(route.id)) throw new PoppyError('conversation_not_found');
        if ((exchange.headers.accept ?? '').includes('text/event-stream')) {
          return stream(exchange, principal, route.id);
        }
        const wait = waitMs(exchange, maxWait);
        const cursor = cursorOf(exchange);
        const result = await conversations.read(principal, route.id, {
          ...(cursor !== undefined ? { cursor } : {}),
          waitMs: wait,
        });
        return exchange.json(200, result);
      }
      case 'handoff': {
        if (!isPoppyId(route.id)) throw new PoppyError('conversation_not_found');
        await conversations.owned(principal, route.id);
        parseEmptyBody(await exchange.readBody(maxBody));
        const state = await conversations.requestHandoff(principal, route.id);
        return exchange.json(202, { conversation_id: route.id, ...state });
      }
      case 'close': {
        if (!isPoppyId(route.id)) throw new PoppyError('conversation_not_found');
        await conversations.owned(principal, route.id);
        parseEmptyBody(await exchange.readBody(maxBody));
        const state = await conversations.closeByAgent(principal, route.id);
        return exchange.json(200, { conversation_id: route.id, ...state });
      }
    }
  }

  /**
   * A message POST's answer: its status and body — or, with `wait`, a read of the events from
   * `cursor` (the start without one), still under the POST's status (§7.3).
   */
  async function answerPost(
    exchange: PoppyExchange,
    principal: PoppyPrincipal,
    conversationId: string,
    answer: { status: number; body: Record<string, unknown> },
  ): Promise<void> {
    if (exchange.query.wait === undefined) return exchange.json(answer.status, answer.body);
    const wait = waitMs(exchange, maxWait);
    const conversation = await conversations.owned(principal, conversationId);
    const cursor = cursorOf(exchange);
    const read = await conversations.readOwned(conversation, {
      ...(cursor !== undefined ? { cursor } : {}),
      waitMs: wait,
    });
    return exchange.json(answer.status, read);
  }

  return async function handle(exchange: PoppyExchange): Promise<boolean> {
    const path = exchange.path.replace(/\/+$/, '');
    if (path !== base && !path.startsWith(`${base}/`)) return false;
    const rest = path
      .slice(base.length)
      .split('/')
      .filter((segment) => segment !== '');
    let decoded: string[];
    try {
      decoded = rest.map((segment) => decodeURIComponent(segment));
    } catch {
      decoded = ['', ''];
    }
    const matched = matchRoute(exchange.method.toUpperCase(), decoded);
    try {
      if (matched === 404) throw new PoppyError('not_found');
      if (matched === 405) throw new PoppyError('method_not_allowed');
      await route(exchange, matched);
    } catch (error) {
      const poppy =
        error instanceof PoppyError
          ? error
          : (error as { name?: string })?.name === 'PoppyError'
            ? (error as PoppyError)
            : null;
      if (poppy === null) options.onError?.(error);
      const answer = poppy ?? new PoppyError('server_error', 'Internal error');
      exchange.json(
        answer.status,
        answer.toJSON(),
        answer.code === 'sign_in_required'
          ? { 'WWW-Authenticate': `${schemeOf(exchange)} error="sign_in_required"` }
          : answer.code === 'method_not_allowed'
            ? { Allow: matched === 405 ? allowFor(decoded) : '' }
            : {},
      );
    }
    return true;
  };
}

function allowFor(rest: string[]): string {
  return rest.length === 2 && rest[1] === 'events' ? 'GET' : 'POST';
}

// ── exchanges ─────────────────────────────────────────────────────────────────

function rawLowerHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  return out;
}

function lowerHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

const tooLarge = () => new PoppyError('request_too_large', 'Request body is too large');

async function readStream(source: AsyncIterable<unknown>, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > limit) throw tooLarge();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function writer(res: ServerResponse, req: IncomingMessage): PoppyStreamWriter {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.on('close', abort);
  res.on('close', abort);
  return {
    write: (chunk) => {
      if (!res.writableEnded) res.write(chunk);
    },
    end: () => {
      if (!res.writableEnded) res.end();
    },
    signal: controller.signal,
  };
}

function nodeResponses(
  req: IncomingMessage,
  res: ServerResponse,
): Pick<PoppyExchange, 'json' | 'openStream'> {
  return {
    json(status, body, headers = {}) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    },
    openStream(headers) {
      res.writeHead(200, headers);
      res.flushHeaders?.();
      return writer(res, req);
    },
  };
}

/**
 * A {@link PoppyExchange} over a plain Node request whose body is still on the socket — a bare
 * `http` server, or any framework mounted ahead of its body parser.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec).
 */
export function nodeExchange(
  req: IncomingMessage,
  res: ServerResponse,
  options: { origin: string },
): PoppyExchange {
  const target = new URL(req.url ?? '/', options.origin);
  return {
    method: req.method ?? 'GET',
    path: target.pathname,
    query: Object.fromEntries(target.searchParams),
    url: target.toString(),
    headers: lowerHeaders(req.headers),
    rawHeaders: rawLowerHeaders(req.headers),
    readBody: (limit) => readStream(req, limit),
    ...nodeResponses(req, res),
  };
}

/**
 * The public origin of a request: `baseUrl`'s origin when configured; else the request's protocol
 * and host (Express honours `X-Forwarded-*` from proxies it trusts — `app.set('trust proxy', …)`) —
 * upgraded to `https` when the Poppy issuer is, as a TLS-terminating proxy would otherwise make
 * every DPoP `htu` mismatch.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec).
 */
export function publicOrigin(
  request: { protocol: string; host: string },
  baseUrl: string | undefined,
  issuer: string | undefined = globalPoppyIssuer(),
): string {
  if (baseUrl !== undefined) return new URL(baseUrl).origin;
  const protocol =
    request.protocol === 'http' && issuer?.startsWith('https:') ? 'https' : request.protocol;
  return `${protocol}://${request.host}`;
}

/**
 * The Express request fields the exchange reads: a body parser may have consumed the body already
 * (Nest registers JSON and urlencoded parsers ahead of every module's middleware).
 */
export interface PoppyExpressRequest extends IncomingMessage {
  originalUrl?: string;
  protocol?: string;
  host?: string;
  hostname?: string;
  get?(name: string): string | undefined;
  /** Kept by the body parser when the app was created with `{ rawBody: true }`. */
  rawBody?: Buffer | string;
  body?: unknown;
  /** Set by `body-parser` once it consumed the stream. */
  _body?: boolean;
}

/** Why a body parser in front of the endpoint refused the body (an Express error middleware's error). */
export function bodyParserFailure(error: unknown): PoppyError {
  const status = (error as { status?: unknown; statusCode?: unknown } | null)?.status;
  const type = (error as { type?: unknown } | null)?.type;
  if (status === 413 || type === 'entity.too.large') return tooLarge();
  return new PoppyError('invalid_request', 'The request body is not valid JSON');
}

/**
 * The body of an Express request: still on the socket, or what a body parser left — the raw bytes
 * when the app keeps them (`rawBody: true`), else the parsed value written back as JSON. Either way
 * within `limit`, and only once the request is authenticated.
 */
async function expressBody(
  req: PoppyExpressRequest,
  limit: number,
  failure: PoppyError | undefined,
): Promise<string> {
  if (failure !== undefined) throw failure;
  if (req.rawBody !== undefined) {
    const raw = typeof req.rawBody === 'string' ? Buffer.from(req.rawBody) : req.rawBody;
    if (raw.length > limit) throw tooLarge();
    return raw.toString('utf8');
  }
  const consumed = req._body === true || req.readableEnded === true;
  if (!consumed) return readStream(req, limit);
  const body = req.body;
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > limit) throw tooLarge();
    return body;
  }
  if (Buffer.isBuffer(body)) {
    if (body.length > limit) throw tooLarge();
    return body.toString('utf8');
  }
  // A JSON body the parser turned into a value: the same message, written back (§3.3 ignores key
  // order and unknown fields anyway). An empty object from a body-less request reads as no body.
  if (
    typeof body === 'object' &&
    Object.keys(body).length === 0 &&
    !req.headers['content-length']
  ) {
    return '';
  }
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text) > limit) throw tooLarge();
  return text;
}

/**
 * A {@link PoppyExchange} over an Express request — what `AgentPoppyModule` mounts. The public URL
 * is `baseUrl`'s origin (or the request's own, see {@link publicOrigin}) plus the request's
 * original path, so a global prefix and a mounted sub-app are kept as the client sent them.
 *
 * `failure` is a body parser's refusal (bad JSON, too large): the request is still authenticated
 * first, and only then answered with it.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec).
 */
export function expressExchange(
  req: PoppyExpressRequest,
  res: ServerResponse,
  options: { baseUrl?: string; failure?: PoppyError },
): PoppyExchange {
  const host = req.get?.('host') ?? req.headers.host ?? 'localhost';
  const protocol = req.protocol ?? 'http';
  const origin = publicOrigin({ protocol, host }, options.baseUrl);
  const target = new URL(req.originalUrl ?? req.url ?? '/', `${origin}/`);
  return {
    method: req.method ?? 'GET',
    path: target.pathname,
    query: Object.fromEntries(target.searchParams),
    url: `${origin}${target.pathname}${target.search}`,
    headers: lowerHeaders(req.headers),
    rawHeaders: rawLowerHeaders(req.headers),
    readBody: (limit) => expressBody(req, limit, options.failure),
    ...nodeResponses(req, res),
  };
}
