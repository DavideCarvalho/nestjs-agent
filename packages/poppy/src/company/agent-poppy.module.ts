import type { IncomingMessage, ServerResponse } from 'node:http';
import { AGENT_SERVICE } from '@dudousxd/nestjs-agent';
import {
  AGENT_POPPY_STORE,
  AGENT_TOOL_REGISTRY,
  InMemoryPoppyStore,
  type PoppyStore,
  type ToolRegistry,
} from '@dudousxd/nestjs-agent-core';
import {
  type DynamicModule,
  Inject,
  Logger,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { PersonalAgentTurnService } from '../turn.js';
import type {
  AgentPoppyModuleAsyncOptions,
  AgentPoppyModuleOptions,
} from './agent-poppy.options.js';
import { globalPoppyAuthenticate } from './auth.js';
import { PoppyConversations } from './conversations.js';
import { announcePoppyEndpoints, poppyConversationsUrl } from './endpoints.js';
import {
  type PoppyExpressRequest,
  bodyParserFailure,
  createPoppyHandler,
  expressExchange,
  isPoppyPath,
} from './handler.js';
import { AGENT_POPPY_OPTIONS } from './tokens.js';

const DEFAULT_PATH = 'poppy/conversations';

function normalizePath(path: string | undefined): string {
  return (path ?? DEFAULT_PATH).replace(/^\/+|\/+$/g, '');
}

const logger = new Logger('AgentPoppy');

/** `PoppyConversations` over the options and what `AgentModule` (and a store module) provide. */
function conversationsProvider(): Provider {
  return {
    provide: PoppyConversations,
    inject: [
      AGENT_POPPY_OPTIONS,
      { token: AGENT_SERVICE, optional: true },
      { token: AGENT_TOOL_REGISTRY, optional: true },
      { token: AGENT_POPPY_STORE, optional: true },
    ],
    useFactory: (
      options: AgentPoppyModuleOptions,
      agentService: PersonalAgentTurnService | undefined,
      registry: ToolRegistry | undefined,
      boundStore: PoppyStore | undefined,
    ): PoppyConversations => {
      const service = options.service ?? agentService;
      if (service === undefined) {
        throw new Error(
          'AgentPoppyModule needs AgentModule (its AgentService answers the turns) — import AgentModule.forRoot(…), or pass `service`.',
        );
      }
      let store = options.store ?? boundStore;
      if (store === undefined) {
        logger.warn(
          'poppy: no PoppyStore — conversations live in this process only and are lost on restart. Bind AGENT_POPPY_STORE (a store module) or pass `store` for production.',
        );
        store = new InMemoryPoppyStore();
      }
      return new PoppyConversations({
        store,
        service,
        toolRoles: (name) => service.toolRoles?.(name) ?? registry?.spec(name)?.roles,
        ...(options.agent !== undefined ? { agentName: options.agent } : {}),
        actions: options.actions ?? 'approve-delegated',
        timeoutMs: options.timeoutMs ?? 120_000,
        ...(options.drive !== undefined ? { drive: options.drive } : {}),
        ...(options.actorFor !== undefined ? { actorFor: options.actorFor } : {}),
        ...(options.handoff !== undefined ? { handoff: options.handoff } : {}),
        ...(options.direct !== undefined ? { direct: options.direct } : {}),
        ...(options.texts !== undefined ? { texts: options.texts } : {}),
        ...(options.formatAction !== undefined ? { formatAction: options.formatAction } : {}),
        ...(options.retentionMs !== undefined ? { retentionMs: options.retentionMs } : {}),
        onError: (error, context) =>
          logger.error(context, error instanceof Error ? error.stack : String(error)),
      });
    },
  };
}

type Next = (error?: unknown) => void;
type ExpressLike = {
  use(handler: (...args: never[]) => unknown): unknown;
};

/** A body parser's own error (`body-parser` marks every one with a `type`). */
function isBodyParserError(error: unknown): boolean {
  return typeof (error as { type?: unknown } | null)?.type === 'string';
}

/**
 * Exposes a registered agent as the Company Agent of Personal Agent Protocol ("Poppy", Draft 0.1)
 * conversations (§7). Answers, under its `path` (default `poppy/conversations`):
 *
 * - `POST {path}` — start a conversation (or a Direct Conversation) with its first message;
 * - `POST {path}/{id}/messages` — another message;
 * - `GET {path}/{id}/events` — read events (cursor, `wait`), or stream them as SSE;
 * - `POST {path}/{id}/handoff`, `POST {path}/{id}/close`.
 *
 * Mounted on the Express app itself, in the middleware phase — ahead of Nest's router, so no guard,
 * interceptor or pipe of the app's (or of the agent's own routes) applies: a Poppy request is
 * authenticated by its Session Token, and BEFORE its body is acted on. Nest's body parser runs
 * first; the exchange reads what it left (see `expressExchange`), and a body it refused is still
 * authenticated before being answered. Import it after `AgentModule`, whose `AgentService` answers.
 * `PoppyConversations` is exported — the app drives the Company side through it (a person joining,
 * `user_requested`).
 *
 * ```ts
 * imports: [
 *   AgentModule.forRoot({ … }),
 *   AgentPoppyModule.forRoot({ baseUrl: 'https://api.acme.com', agent: 'support' }),
 * ]
 * ```
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec),
 * a spec still in development: this API WILL change as the spec evolves — possibly in breaking
 * ways, outside semver majors while it is a draft.
 */
@Module({})
export class AgentPoppyModule
  implements NestModule, OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  constructor(
    @Inject(AGENT_POPPY_OPTIONS) private readonly options: AgentPoppyModuleOptions,
    @Inject(PoppyConversations) private readonly conversations: PoppyConversations,
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
  ) {}

  static forRoot(options: AgentPoppyModuleOptions = {}): DynamicModule {
    return {
      module: AgentPoppyModule,
      providers: [{ provide: AGENT_POPPY_OPTIONS, useValue: options }, conversationsProvider()],
      exports: [PoppyConversations],
    };
  }

  static forRootAsync(options: AgentPoppyModuleAsyncOptions): DynamicModule {
    return {
      module: AgentPoppyModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: AGENT_POPPY_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        conversationsProvider(),
      ],
      exports: [PoppyConversations],
    };
  }

  /**
   * Nest calls this while it registers middleware — after its body parsers, before any route. The
   * handler goes on the Express app directly rather than through the consumer: its path is the
   * server's (no global prefix), and an error middleware is needed to answer a body the parser
   * refused, which a consumer middleware cannot be.
   */
  configure(_consumer: MiddlewareConsumer): void {
    const adapter = this.adapterHost.httpAdapter;
    if (adapter === undefined || adapter === null) return;
    if (adapter.getType() !== 'express') {
      logger.warn(
        `poppy: the endpoint mounts on Express only (this app runs ${adapter.getType()}) — it is not served.`,
      );
      return;
    }
    const app = adapter.getInstance() as ExpressLike;
    const path = normalizePath(this.options.path);
    const handle = createPoppyHandler({
      path,
      conversations: this.conversations,
      ...(this.options.authenticate !== undefined
        ? { authenticate: this.options.authenticate }
        : {}),
      maxBodyBytes: this.options.maxBodyBytes ?? 1024 * 1024,
      maxWaitSeconds: this.options.maxWaitSeconds ?? 30,
      streamMaxMs: this.options.streamMaxMs ?? 300_000,
      onError: (error) =>
        logger.error('poppy: request failed', error instanceof Error ? error.stack : String(error)),
    });
    const baseUrl = this.options.baseUrl;
    const ours = (req: PoppyExpressRequest) =>
      isPoppyPath((req.originalUrl ?? req.url ?? '/').split('?')[0] ?? '/', path);
    const serve = (
      req: PoppyExpressRequest,
      res: ServerResponse,
      next: Next,
      failure?: ReturnType<typeof bodyParserFailure>,
    ) => {
      handle(
        expressExchange(req, res, {
          ...(baseUrl !== undefined ? { baseUrl } : {}),
          ...(failure !== undefined ? { failure } : {}),
        }),
      ).then((handled) => {
        if (!handled) next();
      }, next);
    };
    app.use((req: IncomingMessage, res: ServerResponse, next: Next) => {
      const request = req as PoppyExpressRequest;
      if (!ours(request)) return next();
      serve(request, res, next);
    });
    app.use((error: unknown, req: IncomingMessage, res: ServerResponse, next: Next) => {
      const request = req as PoppyExpressRequest;
      if (!ours(request) || !isBodyParserError(error)) return next(error);
      serve(request, res, next, bodyParserFailure(error));
    });
  }

  /**
   * Tell an authorization server in this process where conversations are, for `poppy.json`. Only
   * with `baseUrl`: an absolute URL cannot be known before a request.
   */
  onModuleInit(): void {
    if (this.options.baseUrl !== undefined) {
      announcePoppyEndpoints({
        conversations: poppyConversationsUrl(
          this.options.baseUrl,
          normalizePath(this.options.path),
        ),
      });
    }
  }

  /** Warn, once the app is up, when no one can verify a Session Token: every request is a 501. */
  onApplicationBootstrap(): void {
    if (this.options.authenticate !== undefined || globalPoppyAuthenticate()) return;
    logger.warn(
      'poppy: no Session Token resolver — install an authorization server with Poppy enabled, or set `authenticate` in AgentPoppyModule.forRoot(…). Until then the endpoint answers 501.',
    );
  }

  onModuleDestroy(): void {
    this.conversations.shutdown();
  }
}
