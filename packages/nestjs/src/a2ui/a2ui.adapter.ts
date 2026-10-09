import { AGENT_ACTOR_RESOLVER, type ActorResolver } from '@dudousxd/nestjs-agent-core';
import {
  A2UI_APPROVE_ACTION,
  A2UI_REJECT_ACTION,
  A2uiProjector,
  type A2uiServerMessage,
  type A2uiStreamOptions,
  readA2uiAction,
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
  HttpCode,
  Inject,
  Optional,
  Post,
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
}

/** The surface an A2UI decision is recorded as having come through. */
const A2UI_VIA = 'a2ui';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(code: string, message: string): BadRequestException {
  return new BadRequestException({ statusCode: 400, code, message });
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
  ) {}

  async handle(req: Request, res: Response, raw: unknown): Promise<void> {
    const body = isRecord(raw) ? raw : {};
    const agentName =
      typeof body.agent === 'string' && body.agent.length > 0 ? body.agent : undefined;
    const actor = await this.actorResolver.resolve(req);

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
      if (address === undefined || address === null || address.kind !== 'approval') {
        throw invalid('invalid_action', 'an approval action carries the interruptId it decides');
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
    });
    await this.stream(res, started.runId, { threadId: started.threadId });
  }

  /** Write one run as A2UI JSON Lines, until it ends or stops to ask. */
  protected async stream(
    res: Response,
    runId: string,
    options: { threadId?: string; skip?: number; answered?: string[] },
  ): Promise<void> {
    res.status(200);
    res.setHeader('Content-Type', 'application/jsonl; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Agent-Run-Id', runId);
    if (options.threadId !== undefined) res.setHeader('X-Agent-Thread-Id', options.threadId);
    res.flushHeaders();
    const projector = new A2uiProjector(this.projection);
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
 * The body is `{ threadId?, message?, action?, uiCapabilities?, agent? }`:
 *  - `message` — the user's text;
 *  - `action` — an A2UI client message (`{ version: 'v0.9', action: { name, surfaceId,
 *    sourceComponentId, timestamp, context } }`, or v0.8's `{ userAction }`): it becomes the turn
 *    (`uiActionText`). `agora.approve` / `agora.reject` with `context.interruptId` decide the
 *    approval a previous stream ended on, and stream the rest of that run;
 *  - `threadId` — continue that thread (its owner is checked), or start one under that id.
 *
 * Response headers name the library's ids: `X-Agent-Thread-Id`, `X-Agent-Run-Id`. Authenticated by
 * the module's `actorResolver`, guarded by its `guards` and owner-scoped exactly as `chat` is.
 * Components nothing maps are drawn as their text, from the `AgentGenuiModule` catalog when there
 * is one (or `catalog` here).
 */
export function a2uiAdapter(options: A2uiAdapterOptions = {}): AgentProtocolAdapter {
  const path = (options.path ?? 'a2ui').replace(/^\/+|\/+$/g, '');
  const { path: _path, quietMs, maxActionBytes, ...projection } = options;

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
      );
    }

    @Post(path)
    @HttpCode(200)
    run(@Req() req: Request, @Res() res: Response, @Body() body: unknown): Promise<void> {
      return this.handle(req, res, body);
    }
  }

  return { name: 'a2ui', controllers: [A2uiController] };
}
