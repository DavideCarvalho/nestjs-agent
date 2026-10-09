import { AGENT_ACTOR_RESOLVER, type ActorResolver } from '@dudousxd/nestjs-agent-core';
import {
  A2UI_APPROVE_ACTION,
  A2UI_REJECT_ACTION,
  A2uiProjector,
  type A2uiServerMessage,
  type A2uiStreamOptions,
  a2uiThreadReplay,
  negotiateA2uiCatalog,
  readA2uiAction,
  readA2uiClientCapabilities,
} from '@dudousxd/nestjs-agent-core/a2ui';
import {
  agUiEvents,
  agUiFramesFromNdjson,
  decodeInterruptId,
} from '@dudousxd/nestjs-agent-core/ag-ui';
import {
  type Catalog,
  type UiAction,
  type UiCapabilities,
  uiActionText,
  validateUiCapabilities,
} from '@dudousxd/nestjs-agent-core/genui';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AGENT_SERVICE } from '../agent-service.token.js';
import type { AgentService } from '../agent.service.js';
import { GENUI_CATALOG } from '../genui/agent-genui.module.js';
import type { AgentProtocolAdapter } from '../protocol-adapter.js';

export interface A2uiAdapterOptions extends A2uiStreamOptions {
  /** Where the route mounts, under the agent's path. Default `'a2ui'` → `POST <path>/a2ui`. */
  path?: string;
  /** As `agUiAdapter`'s: how long a run waiting on a person may stay silent before the stream ends. */
  quietMs?: number;
  /** Largest action accepted, as JSON, in bytes. Default 8192. */
  maxActionBytes?: number;
  /** Largest `a2uiClientDataModel` accepted, as JSON, in bytes. Default 32768. */
  maxDataModelBytes?: number;
}

/** The surface an A2UI decision is recorded as having come through. */
const A2UI_VIA = 'a2ui';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(code: string, message: string): BadRequestException {
  return new BadRequestException({ statusCode: 400, code, message });
}

/** A field of the body, or of its A2A-style `metadata` (where A2UI puts client capabilities). */
function bodyField(body: Record<string, unknown>, key: string): unknown {
  if (body[key] !== undefined) return body[key];
  return isRecord(body.metadata) ? body.metadata[key] : undefined;
}

/** `a2uiClientDataModel` (`{ version, surfaces: { <surfaceId>: model } }`): its surfaces, or why not. */
function readDataModel(
  raw: unknown,
  maxBytes: number,
): Record<string, unknown> | undefined | string {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || !isRecord(raw.surfaces)) {
    return 'a2uiClientDataModel carries { version, surfaces }';
  }
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(raw.surfaces)).length;
  } catch {
    return 'a2uiClientDataModel must be JSON';
  }
  if (size > maxBytes) {
    return `a2uiClientDataModel may be at most ${maxBytes} bytes (this one is ${size})`;
  }
  return Object.keys(raw.surfaces).length > 0 ? raw.surfaces : undefined;
}

/**
 * Serves the agent as an A2UI agent. Not mounted directly — {@link a2uiAdapter} mounts a subclass at
 * the configured path — but exported so a host can extend it under a route of its own.
 */
export class A2uiRunHandler {
  constructor(
    protected readonly agent: AgentService,
    protected readonly actorResolver: ActorResolver,
    protected readonly projection: A2uiStreamOptions,
    protected readonly quietMs: number | undefined,
    protected readonly maxActionBytes: number | undefined,
    protected readonly maxDataModelBytes: number | undefined = undefined,
  ) {}

  /**
   * `GET <path>/a2ui/threads/:threadId`: a stored thread as `{ threadId, entries }`
   * (`a2uiThreadReplay`) — what a client draws again after a reload. Owner-scoped; a thread nobody
   * has answers `{ entries: [] }`. `?catalog=<id>` names the client's basic catalog id.
   */
  async replay(
    req: Request,
    threadId: string,
    catalog: unknown,
  ): Promise<{ threadId: string; entries: ReturnType<typeof a2uiThreadReplay> }> {
    const actor = await this.actorResolver.resolve(req);
    const owner = await this.agent.threadOwner(threadId);
    if (owner === null) return { threadId, entries: [] };
    const thread = await this.agent.getThread(actor, threadId);
    const supported =
      typeof catalog === 'string'
        ? [catalog]
        : Array.isArray(catalog)
          ? catalog.filter((id): id is string => typeof id === 'string')
          : undefined;
    return {
      threadId,
      entries: a2uiThreadReplay(
        thread?.messages ?? [],
        negotiateA2uiCatalog(this.projection, supported),
      ),
    };
  }

  async handle(req: Request, res: Response, raw: unknown): Promise<void> {
    const body = isRecord(raw) ? raw : {};
    const agentName =
      typeof body.agent === 'string' && body.agent.length > 0 ? body.agent : undefined;
    const actor = await this.actorResolver.resolve(req);
    // The basic catalog under the id this client advertises (`a2uiClientCapabilities`).
    const projection = negotiateA2uiCatalog(
      this.projection,
      readA2uiClientCapabilities(bodyField(body, 'a2uiClientCapabilities')),
    );
    const dataModel = readDataModel(
      bodyField(body, 'a2uiClientDataModel'),
      this.maxDataModelBytes ?? 32768,
    );
    if (typeof dataModel === 'string') throw invalid('invalid_data_model', dataModel);

    let action: UiAction | undefined;
    if (body.action !== undefined) {
      const read = isRecord(body.action)
        ? readA2uiAction(body.action, {
            ...(this.maxActionBytes !== undefined ? { maxBytes: this.maxActionBytes } : {}),
          })
        : 'action must be an A2UI action message';
      if (typeof read === 'string') throw invalid('invalid_action', read);
      action = read;
    }

    // Deciding the approval a stream ended on: settle it, then stream the rest of the run.
    if (action?.name === A2UI_APPROVE_ACTION || action?.name === A2UI_REJECT_ACTION) {
      const interruptId = action.context.interruptId;
      const address = typeof interruptId === 'string' ? decodeInterruptId(interruptId) : undefined;
      if (address === undefined || address === null || address.kind === 'elicitation') {
        throw invalid('invalid_action', 'an approval action carries the interruptId it decides');
      }
      // An independent proposal: decided through the proposal service (its own run is not
      // waiting), as an AG-UI resume decides it, and answered with the configured reply.
      if (address.kind === 'proposal') {
        if (address.proposalId === undefined || address.threadId === undefined) {
          throw invalid('invalid_action', 'the interruptId names no proposal');
        }
        const decided = await this.agent.decideActionProposal(
          actor,
          address.threadId,
          address.proposalId,
          {
            decision: action.name === A2UI_APPROVE_ACTION ? 'approved' : 'rejected',
            via: A2UI_VIA,
          },
        );
        this.writeHead(res, { 'X-Agent-Thread-Id': address.threadId });
        const projector = new A2uiProjector(projection);
        const messageId = `proposal-${address.proposalId}`;
        for (const event of [
          { type: 'TEXT_MESSAGE_START' as const, messageId, role: 'assistant' as const },
          { type: 'TEXT_MESSAGE_CONTENT' as const, messageId, delta: decided.text },
        ]) {
          for (const message of projector.project(event)) res.write(`${JSON.stringify(message)}\n`);
        }
        res.end();
        return;
      }
      // The same checks an AG-UI resume makes: the run is the actor's and still waiting, and the
      // actor may decide this call.
      await this.agent.assertResumable(actor, address.stream);
      await this.agent.checkDecision(actor, address.toolCallId);
      if (action.name === A2UI_APPROVE_ACTION) {
        await this.agent.approve(actor, address.toolCallId, { via: A2UI_VIA });
      } else {
        await this.agent.reject(actor, address.toolCallId, undefined, { via: A2UI_VIA });
      }
      await this.stream(res, address.stream, {
        skip: address.position,
        answered: [address.toolCallId],
        projection,
      });
      return;
    }

    const message = typeof body.message === 'string' ? body.message : '';
    const text = action !== undefined ? uiActionText(action) : message;
    if (text.trim().length === 0) {
      throw invalid('no_user_message', 'send a message or an action');
    }
    const threadId =
      typeof body.threadId === 'string' && body.threadId.length > 0 ? body.threadId : undefined;
    const owner = threadId !== undefined ? await this.agent.threadOwner(threadId) : null;
    if (owner !== null && owner !== actor.id) {
      throw new ForbiddenException('thread belongs to another actor');
    }
    let uiCapabilities: UiCapabilities | undefined;
    if (Object.hasOwn(body, 'uiCapabilities')) {
      try {
        uiCapabilities = validateUiCapabilities(body.uiCapabilities);
      } catch (error) {
        throw invalid('invalid_input', (error as Error).message);
      }
    }
    const started = await this.agent.chat({
      actor,
      message: text,
      ...(threadId === undefined ? {} : owner !== null ? { threadId } : { newThreadId: threadId }),
      ...(agentName !== undefined ? { agentName } : {}),
      ...(uiCapabilities !== undefined ? { uiCapabilities } : {}),
      ...(dataModel !== undefined ? { pageContext: { a2uiDataModel: dataModel } } : {}),
    });
    await this.stream(res, started.runId, { threadId: started.threadId, projection });
  }

  /** Open the JSON Lines response. */
  protected writeHead(res: Response, extra: Record<string, string>): void {
    res.status(200);
    res.setHeader('Content-Type', 'application/jsonl; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    for (const [name, value] of Object.entries(extra)) res.setHeader(name, value);
    res.flushHeaders();
  }

  /** Write one run as A2UI JSON Lines, until it ends or stops to ask. */
  protected async stream(
    res: Response,
    runId: string,
    options: {
      threadId?: string;
      skip?: number;
      answered?: string[];
      projection?: A2uiStreamOptions;
    },
  ): Promise<void> {
    this.writeHead(res, {
      'X-Agent-Run-Id': runId,
      ...(options.threadId !== undefined ? { 'X-Agent-Thread-Id': options.threadId } : {}),
    });
    const projector = new A2uiProjector(options.projection ?? this.projection);
    const write = (messages: A2uiServerMessage[]) => {
      for (const message of messages) res.write(`${JSON.stringify(message)}\n`);
    };
    try {
      const frames = agUiFramesFromNdjson(this.agent.subscribe(runId));
      for await (const event of agUiEvents(frames, {
        threadId: options.threadId ?? runId,
        runId,
        streamRunId: runId,
        ...(options.threadId !== undefined ? { streamThreadId: options.threadId } : {}),
        ...(options.skip !== undefined ? { skip: options.skip } : {}),
        ...(options.answered !== undefined ? { answered: options.answered } : {}),
        ...(this.quietMs !== undefined ? { quietMs: this.quietMs } : {}),
      })) {
        write(projector.project(event));
      }
    } catch {
      write(projector.project({ type: 'RUN_ERROR', message: 'The run could not be followed.' }));
    }
    res.end();
  }
}

/**
 * Serve the agent as an A2UI (https://a2ui.org, v0.9) agent: `POST <path>/a2ui` answers with the
 * run as a JSON Lines stream of A2UI server-to-client messages — `createSurface`,
 * `updateComponents`, `updateDataModel`, `deleteSurface` — that any A2UI renderer draws.
 *
 * ```ts
 * import { a2uiAdapter } from '@dudousxd/nestjs-agent/a2ui'
 *
 * AgentModule.forRoot({ model, adapters: [a2uiAdapter()] })
 * ```
 *
 * The body is `{ threadId?, message?, action?, uiCapabilities?, a2uiClientCapabilities?,
 * a2uiClientDataModel?, agent? }` (the two A2UI fields also read from `metadata`, A2A-style):
 *  - `message` — the user's text;
 *  - `action` — an A2UI client message (`{ version: 'v0.9', action: { name, surfaceId,
 *    sourceComponentId, timestamp, context } }`, or v0.8's `{ userAction }`): it becomes the turn
 *    (`uiActionText`). `agora.approve` / `agora.reject` with `context.interruptId` decide the
 *    approval a previous stream ended on, and stream the rest of that run (an independent
 *    proposal is decided through the proposal service and answered with its reply);
 *  - `threadId` — continue that thread (its owner is checked), or start one under that id;
 *  - `a2uiClientCapabilities` — the catalogs the client draws (`{ 'v0.9': { supportedCatalogIds } }`,
 *    what `MessageProcessor.getRendererCapabilities()` builds): the basic catalog is sent under the
 *    id the client lists for it;
 *  - `a2uiClientDataModel` — the data models of surfaces created with `sendDataModel`, handed to the
 *    prompt builder as `pageContext.a2uiDataModel`.
 *
 * `GET <path>/a2ui/threads/:threadId` answers a stored thread as `{ threadId, entries }`
 * (`a2uiThreadReplay`): what a client draws again after a reload.
 *
 * Response headers name the library's ids: `X-Agent-Thread-Id`, `X-Agent-Run-Id`. Authenticated by
 * the module's `actorResolver`, guarded by its `guards` and owner-scoped exactly as `chat` is.
 * Components nothing maps are drawn as their text, from the `AgentGenuiModule` catalog when there
 * is one (or `catalog` here).
 */
export function a2uiAdapter(options: A2uiAdapterOptions = {}): AgentProtocolAdapter {
  const path = (options.path ?? 'a2ui').replace(/^\/+|\/+$/g, '');
  const { path: _path, quietMs, maxActionBytes, maxDataModelBytes, ...projection } = options;

  @Controller()
  class A2uiController extends A2uiRunHandler {
    constructor(
      // Tokens, never classes: this entry is its own bundle (see AGENT_SERVICE).
      @Inject(AGENT_SERVICE) agent: AgentService,
      @Inject(AGENT_ACTOR_RESOLVER) actorResolver: ActorResolver,
      @Optional() @Inject(GENUI_CATALOG) catalog?: Catalog,
    ) {
      super(
        agent,
        actorResolver,
        projection.catalog === undefined && catalog !== undefined
          ? { ...projection, catalog }
          : projection,
        quietMs,
        maxActionBytes,
        maxDataModelBytes,
      );
    }

    @Get(`${path}/threads/:threadId`)
    thread(
      @Req() req: Request,
      @Param('threadId') threadId: string,
      @Query('catalog') catalog: unknown,
    ): ReturnType<A2uiRunHandler['replay']> {
      return this.replay(req, threadId, catalog);
    }

    @Post(path)
    @HttpCode(200)
    run(@Req() req: Request, @Res() res: Response, @Body() body: unknown): Promise<void> {
      return this.handle(req, res, body);
    }
  }

  return { name: 'a2ui', controllers: [A2uiController] };
}
