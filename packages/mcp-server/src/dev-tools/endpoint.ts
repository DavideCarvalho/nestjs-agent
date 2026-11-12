import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type CallToolResult,
  McpServer,
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedOrigins,
  originValidationResponse,
} from '@modelcontextprotocol/server';
import {
  type CanActivate,
  Controller,
  Delete,
  type ExecutionContext,
  Get,
  HttpException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
  Post,
  Req,
  Res,
  type Type,
} from '@nestjs/common';
import type { AgentMcpServerModuleOptions } from '../agent-mcp-server.options.js';
import { AGENT_MCP_SERVER_OPTIONS } from '../tokens.js';
import { type DevToolsSnapshot, type ServedDevToolsLib, servedLibs, snapshot } from './catalog.js';
import {
  type DevTool,
  type DevToolsCaller,
  type DevToolsDecision,
  devToolsSlot,
} from './contract.js';
import {
  DEV_TOOLS_MAX_BYTES,
  DEV_TOOLS_MAX_ROWS,
  capDevToolResult,
  redactDevToolOutput,
  truncateText,
} from './limits.js';
import { type DevToolsActions, type ResolvedDevToolsOptions, actionAllowed } from './options.js';
import { devToolStandardSchema, validateDevToolInput } from './schema.js';

/** DI token: the dev endpoint's resolved options. */
export const AGENT_DEV_TOOLS_OPTIONS = Symbol.for('@dudousxd/nestjs-agent-mcp-server:dev-tools');

/** Where the guard leaves its admission for the controller. */
const ADMISSION = Symbol.for('@dudousxd/nestjs-agent-mcp-server:dev-tools-admission');

const logger = new Logger('AgentDevTools');

/** What the guard decided for one request. */
interface Admission {
  caller: DevToolsCaller;
  allowed: ServedDevToolsLib[];
  context: ExecutionContext;
}

type DevRequest = IncomingMessage & {
  body?: unknown;
  user?: unknown;
  [ADMISSION]?: Admission;
};

/** The 401 / 403 the dev endpoint answers, in the consoles' JSON shape. */
export class DevToolsRefusal extends HttpException {
  constructor(status: 401 | 403, error: string) {
    super({ error }, status);
  }
}

// ── the service ─────────────────────────────────────────────────────────────

/**
 * The dev MCP endpoint: stateless, re-authorized per request and per lib. It reads the dev-tools
 * slot at request time, so a lib that registers after boot is served too.
 */
@Injectable()
export class AgentDevToolsEndpoint
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown
{
  readonly #requests = new AsyncLocalStorage<Admission>();
  readonly #handler: ReturnType<typeof createMcpHandler>;
  readonly #reported = new Set<string>();
  readonly #allowedHosts: string[] | undefined;
  readonly #allowedOrigins: string[] | undefined;

  constructor(
    @Inject(AGENT_DEV_TOOLS_OPTIONS) readonly options: ResolvedDevToolsOptions,
    @Inject(AGENT_MCP_SERVER_OPTIONS) private readonly server: AgentMcpServerModuleOptions,
  ) {
    const http = server.mcp?.http;
    this.#allowedHosts = http?.allowedHosts !== undefined ? [...http.allowedHosts] : undefined;
    this.#allowedOrigins =
      http?.allowedOrigins === false
        ? undefined
        : http?.allowedOrigins !== undefined
          ? [...http.allowedOrigins]
          : localhostAllowedOrigins();
    this.#handler = createMcpHandler(
      () => {
        const admission = this.#requests.getStore();
        if (admission === undefined) throw new Error('dev tools: no admission for this request');
        return this.#serverFor(admission);
      },
      {
        onerror: (error) => logger.debug(`dev tools request rejected: ${error.message}`),
      },
    );
  }

  /** The slot exists once the endpoint does, so a lib that boots later finds it. */
  onModuleInit(): void {
    devToolsSlot();
  }

  /** One line listing the libs and their tools, once every module has registered. */
  onApplicationBootstrap(): void {
    const snap = this.snapshot();
    const libs = servedLibs(snap);
    const list =
      libs.length === 0
        ? 'no lib registered tools yet'
        : libs.map((lib) => `${lib.lib} (${lib.tools.length})`).join(', ');
    logger.log(`dev tools at /${this.options.path}: ${list}`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.#handler.close();
  }

  /** The slot right now, `exclude` applied. A lib registered wrongly is reported once and skipped. */
  snapshot(): DevToolsSnapshot {
    const snap = snapshot(this.options.exclude);
    for (const { lib, problem } of snap.rejected) {
      if (this.#reported.has(problem)) continue;
      this.#reported.add(problem);
      logger.error(`dev tools of "${lib}" are not served: ${problem}`);
    }
    return snap;
  }

  /** Host and Origin checks, as the product endpoint does them. A refusal, or `undefined`. */
  checkOrigin(req: IncomingMessage): DevToolsRefusal | undefined {
    const headers = new Headers();
    for (const name of ['host', 'origin'] as const) {
      const value = req.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    const probe = new Request('http://localhost/', { headers });
    const rejected =
      (this.#allowedHosts !== undefined &&
        hostHeaderValidationResponse(probe, this.#allowedHosts)) ||
      (this.#allowedOrigins !== undefined && originValidationResponse(probe, this.#allowedOrigins));
    return rejected ? new DevToolsRefusal(403, 'forbidden') : undefined;
  }

  /** Serves one admitted `POST`. */
  async serve(platformRequest: unknown, platformResponse: unknown): Promise<void> {
    const { req, res } = unwrap(platformRequest, platformResponse);
    const admission = req[ADMISSION];
    if (admission === undefined) throw new DevToolsRefusal(403, 'forbidden');
    const abort = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    const parsed = req.body !== undefined;
    let response: Response;
    try {
      const request = await toWebRequest(req, parsed, abort.signal);
      response = await this.#requests.run(admission, () =>
        this.#handler.fetch(request, parsed ? { parsedBody: req.body } : {}),
      );
    } catch (error) {
      logger.error(`dev tools request failed: ${(error as Error)?.message}`);
      response = Response.json(
        { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null },
        { status: 500 },
      );
    }
    await writeWebResponse(response, res);
  }

  /** The SDK server for one request: the allowed libs' tools, available, actions as opted in. */
  async #serverFor(admission: Admission): Promise<McpServer> {
    const actions = this.options.actions;
    const server = new McpServer(
      { name: `${this.server.name} dev tools`, version: this.server.version },
      { capabilities: { tools: {} }, instructions: instructionsFor(admission.allowed, actions) },
    );
    for (const lib of admission.allowed) {
      for (const tool of lib.tools) {
        if (tool.kind === 'action' && !actionAllowed(actions, lib.lib, tool.name)) continue;
        if (!(await isAvailable(tool))) continue;
        server.registerTool(
          tool.name,
          {
            description: tool.description,
            inputSchema: devToolStandardSchema(tool.input),
            annotations: {
              readOnlyHint: tool.kind === 'read',
              ...(tool.kind === 'action' ? { destructiveHint: tool.destructive === true } : {}),
            },
          },
          (args: unknown) => this.#run(admission, lib, tool, args),
        );
      }
    }
    return server;
  }

  async #run(
    admission: Admission,
    lib: ServedDevToolsLib,
    tool: DevTool,
    args: unknown,
  ): Promise<CallToolResult> {
    const started = performance.now();
    let ok = false;
    try {
      // The SDK validated already; validating again keeps `run` safe from any SDK change.
      const checked = validateDevToolInput(tool.input, args);
      if ('issues' in checked) {
        return {
          content: [{ type: 'text', text: checked.issues.map((i) => i.message).join('; ') }],
          isError: true,
        };
      }
      const output = await tool.run(checked.value, {
        context: admission.context,
        caller: admission.caller,
        limits: { maxRows: DEV_TOOLS_MAX_ROWS, maxBytes: DEV_TOOLS_MAX_BYTES },
      });
      const text = capDevToolResult(redactDevToolOutput(output), DEV_TOOLS_MAX_BYTES);
      ok = true;
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: message }], isError: true };
    } finally {
      const ms = Math.round(performance.now() - started);
      const line = {
        devTool: tool.name,
        lib: lib.lib,
        caller: admission.caller.id,
        kind: tool.kind,
        ok,
        ms,
        args: truncateText(JSON.stringify(redactDevToolOutput(args ?? {})), 1024),
      };
      if (tool.kind === 'action') logger.log(line);
      else logger.debug(line);
      void publishDevToolsCall({
        devTool: tool.name,
        lib: lib.lib,
        caller: admission.caller.id,
        kind: tool.kind,
        ok,
        ms,
      });
    }
  }
}

// ── the guard ───────────────────────────────────────────────────────────────

/**
 * Decides who reaches the dev endpoint: the libs a message needs each run their own console
 * `authorize`, once; none allowed → `401` / `403`. Runs after the app's `devTools.decorators`.
 */
@Injectable()
export class AgentDevToolsGuard implements CanActivate {
  constructor(private readonly endpoint: AgentDevToolsEndpoint) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const http = context.switchToHttp();
    const req = unwrapRequest(http.getRequest());
    const refusedOrigin = this.endpoint.checkOrigin(req);
    if (refusedOrigin !== undefined) throw refusedOrigin;

    const snap = this.endpoint.snapshot();
    const needed =
      (req.method ?? 'GET').toUpperCase() === 'POST'
        ? neededLibs(req.body, snap)
        : servedLibs(snap);
    const caller = callerOf(req);

    // One after the other: an `authorize` may touch shared request state (an auth guard's cache).
    const decisions: Array<{ lib: ServedDevToolsLib; decision: DevToolsDecision }> = [];
    for (const lib of needed) {
      decisions.push({ lib, decision: await safeAuthorize(lib, context) });
    }
    const allowed = decisions.filter(({ decision }) => decision.allowed).map(({ lib }) => lib);
    if (needed.length > 0 && allowed.length === 0) {
      const unauthenticated = decisions.some(
        ({ decision }) => !decision.allowed && decision.reason === 'unauthenticated',
      );
      logger.warn({
        devTools: 'refused',
        caller: caller.id,
        libs: needed.map((lib) => lib.lib),
        status: unauthenticated ? 401 : 403,
      });
      if (unauthenticated) {
        setHeader(http.getResponse(), 'WWW-Authenticate', 'Bearer realm="aviary-dev"');
        throw new DevToolsRefusal(401, 'unauthenticated');
      }
      throw new DevToolsRefusal(403, 'forbidden');
    }
    req[ADMISSION] = { caller, allowed, context };
    return true;
  }
}

/**
 * The libs a JSON-RPC message needs: a `tools/call` needs its tool's lib; anything else (a call to a
 * name no lib serves included) needs every lib, so an unknown name never answers with less
 * authorization than a real one (no way to probe which tools exist).
 */
export function neededLibs(body: unknown, snap: DevToolsSnapshot): ServedDevToolsLib[] {
  const served = servedLibs(snap);
  const messages = Array.isArray(body) ? body : [body];
  const needed = new Set<ServedDevToolsLib>();
  for (const message of messages) {
    const call = message as { method?: unknown; params?: { name?: unknown } } | null;
    const name = call?.method === 'tools/call' ? call.params?.name : undefined;
    const lib =
      typeof name === 'string'
        ? served.find((candidate) => candidate.tools.some((tool) => tool.name === name))
        : undefined;
    if (lib === undefined) return served;
    needed.add(lib);
  }
  return [...needed];
}

/** Bearer → `token:<first 12 hex of sha256>`; else `request.user.id` → `user:<id>`; else `dev-open`. */
export function callerOf(req: {
  headers: IncomingMessage['headers'];
  user?: unknown;
}): DevToolsCaller {
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  const match = typeof value === 'string' ? /^Bearer\s+(\S.*)$/i.exec(value.trim()) : null;
  if (match?.[1] !== undefined) {
    const hash = createHash('sha256').update(match[1].trim()).digest('hex').slice(0, 12);
    return { id: `token:${hash}`, via: 'token' };
  }
  const id = (req.user as { id?: unknown } | null | undefined)?.id;
  if (typeof id === 'string' || typeof id === 'number' || typeof id === 'bigint') {
    return { id: `user:${String(id)}`, via: 'session' };
  }
  return { id: 'dev-open', via: 'open' };
}

/** A lib's `authorize`, read the way consoles read it. A throw or a malformed answer is `forbidden`. */
async function safeAuthorize(
  lib: ServedDevToolsLib,
  context: ExecutionContext,
): Promise<DevToolsDecision> {
  try {
    const decision = (await lib.authorize(context)) as Partial<DevToolsDecision> | undefined;
    if (decision?.allowed === true) return { allowed: true };
    const reason = (decision as { reason?: unknown } | undefined)?.reason;
    return {
      allowed: false,
      reason: reason === 'unauthenticated' ? 'unauthenticated' : 'forbidden',
    };
  } catch (error) {
    logger.warn(
      `dev tools: "${lib.lib}" authorize threw, denying: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { allowed: false, reason: 'forbidden' };
  }
}

function instructionsFor(libs: ServedDevToolsLib[], actions: DevToolsActions): string {
  const titles = libs.map((lib) => lib.title);
  const what =
    titles.length > 0 ? `Tools for: ${titles.join(', ')}.` : 'No tools are available to you.';
  const acts =
    actions === 'refuse'
      ? ' Read-only: nothing here changes data.'
      : ' Some tools are actions that change data: confirm with the person first.';
  return `Developer tools of this app's Aviary libraries, as their consoles show them. ${what}${acts} List tools return { items, next }; pass next back to page.`;
}

async function isAvailable(tool: DevTool): Promise<boolean> {
  if (tool.available === undefined) return true;
  try {
    return (await tool.available()) === true;
  } catch {
    return false;
  }
}

// ── the controller ──────────────────────────────────────────────────────────

/** `POST` serves MCP; `GET` / `DELETE` answer 405 (stateless), after the guard. */
class AgentDevToolsControllerBase {
  constructor(private readonly endpoint: AgentDevToolsEndpoint) {}

  @Post()
  async post(@Req() req: unknown, @Res() res: unknown): Promise<void> {
    await this.endpoint.serve(req, res);
  }

  @Get()
  get(@Res() res: unknown): void {
    methodNotAllowed(res);
  }

  @Delete()
  delete(@Res() res: unknown): void {
    methodNotAllowed(res);
  }
}

/** The dev endpoint's controller at `path` (static routing metadata, so built per path). */
export function agentDevToolsController(
  path: string,
  decorators: readonly ClassDecorator[] = [],
): Type<unknown> {
  class AgentDevToolsController extends AgentDevToolsControllerBase {}
  Reflect.defineMetadata('design:paramtypes', [AgentDevToolsEndpoint], AgentDevToolsController);
  for (const decorator of decorators) decorator(AgentDevToolsController);
  Controller(path)(AgentDevToolsController);
  return AgentDevToolsController;
}

function methodNotAllowed(platformResponse: unknown): void {
  const { res } = unwrap(undefined, platformResponse);
  res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: this MCP server is stateless.' },
      id: null,
    }),
  );
}

// ── HTTP plumbing ───────────────────────────────────────────────────────────

/** Express / the Node adapter hand Node's own objects; Fastify's are unwrapped (its reply hijacked). */
function unwrap(
  platformRequest: unknown,
  platformResponse: unknown,
): { req: DevRequest; res: ServerResponse } {
  const reply = platformResponse as { raw?: ServerResponse; hijack?: () => void };
  if (typeof reply.hijack === 'function' && reply.raw !== undefined) {
    reply.hijack();
    return { req: unwrapRequest(platformRequest), res: reply.raw };
  }
  return { req: unwrapRequest(platformRequest), res: platformResponse as ServerResponse };
}

/** Fastify's request carries Node's as `raw`, with the parsed body and user on the wrapper. */
function unwrapRequest(platformRequest: unknown): DevRequest {
  const wrapper = platformRequest as {
    raw?: DevRequest;
    body?: unknown;
    user?: unknown;
  } & DevRequest;
  if (wrapper?.raw !== undefined && wrapper.raw !== wrapper) {
    const raw = wrapper.raw;
    if (raw.body === undefined && wrapper.body !== undefined) raw.body = wrapper.body;
    if (raw.user === undefined && wrapper.user !== undefined) raw.user = wrapper.user;
    return raw;
  }
  return wrapper;
}

function setHeader(platformResponse: unknown, name: string, value: string): void {
  const res = platformResponse as {
    setHeader?: (n: string, v: string) => void;
    header?: (n: string, v: string) => void;
  };
  if (typeof res.setHeader === 'function') res.setHeader(name, value);
  else res.header?.(name, value);
}

const HOP_BY_HOP = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

async function toWebRequest(
  req: DevRequest,
  parsed: boolean,
  signal: AbortSignal,
): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  const method = req.method ?? 'POST';
  let body: Buffer | undefined;
  if (!parsed && method !== 'GET' && method !== 'HEAD' && !req.readableEnded) {
    const chunks: Buffer[] = [];
    for await (const chunk of req)
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    body = Buffer.concat(chunks);
  }
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  return new Request(url, {
    method,
    headers,
    signal,
    ...(body !== undefined && body.length > 0 ? { body } : {}),
  });
}

async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  if (res.headersSent || res.destroyed) {
    await response.body?.cancel().catch(() => {});
    return;
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  res.end(response.body === null ? undefined : Buffer.from(await response.arrayBuffer()));
}

// ── diagnostics ─────────────────────────────────────────────────────────────

interface DevToolsCallEvent {
  devTool: string;
  lib: string;
  caller: string;
  kind: 'read' | 'action';
  ok: boolean;
  ms: number;
}

type Emit = (lib: string, event: string, payload: DevToolsCallEvent) => void;
let emitter: Promise<Emit | undefined> | undefined;

/** `agent:devtools.call`, when `@dudousxd/nestjs-diagnostics` is installed. Never throws. */
async function publishDevToolsCall(payload: DevToolsCallEvent): Promise<void> {
  emitter ??= import('@dudousxd/nestjs-diagnostics').then(
    (mod) => (mod as unknown as { emit: Emit }).emit,
    () => undefined,
  );
  try {
    (await emitter)?.('agent', 'devtools.call', payload);
  } catch {
    // observability never breaks a call
  }
}
