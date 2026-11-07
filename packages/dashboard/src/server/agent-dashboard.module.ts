import { withControllerDecorators } from '@dudousxd/nestjs-agent-core';
import 'reflect-metadata';
import { type DynamicModule, Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { AgentApiController } from './agent-api.controller.js';
import { AgentUiController } from './agent-ui.controller.js';
import { DashboardService } from './dashboard.service.js';
import { normalizeDashboardPath } from './normalize-path.js';
import { DASHBOARD_API_PATH, DASHBOARD_APPROVAL_ACTOR_REF, DASHBOARD_BASE_PATH } from './tokens.js';

/**
 * `TReq` mirrors core's `ActorResolver<TReq>` convention: the transport request type
 * {@link AgentDashboardOptions.approvalActorRef} receives. Defaults to `unknown`.
 */
export interface AgentDashboardOptions<TReq = unknown> {
  /**
   * Where the SPA (UI) is served. Default `/ai-gateway`. This is a page route — keep it out of an
   * `/api` prefix so it reads as a UI, not an endpoint.
   */
  basePath?: string;
  /**
   * Where the JSON API is mounted (what the SPA fetches). Default `<basePath>/api`. Set it under
   * your app's `/api` prefix — e.g. `/api/ai-gateway` — so the API inherits the app's auth/proxy
   * rules while the UI stays at `basePath`.
   */
  apiBasePath?: string;
  /**
   * Who reaches the console: class decorators applied to every controller this module mounts — the
   * ecosystem's convention, like `@nestjs/mcp`'s `decorators` — with the official tools, e.g.
   * `[UseGuards(AuthenticationGuard), Can(ConsolePolicy, 'view')]` from `@nestjs/authentication` /
   * `@nestjs/authorization`, or a function as a guard instance, `UseGuards({ canActivate })`.
   * Applied to a per-registration subclass, so nothing sticks to the shared classes.
   *
   * In production (`NODE_ENV=production`) the console refuses to boot without them, unless the app
   * mounts the routes itself (`routes: false`): a governance console is never served open there by
   * default. Outside production the routes are open (and to `@nestjs/authorization`'s
   * deny-by-default guard: `CanAnyone()`). Static wiring.
   */
  decorators?: ClassDecorator[];
  /**
   * `false` mounts none of the console's routes, while its services still run — the way NestJS's
   * own packages leave routes to you: serve them from controllers of your own, protected with the
   * official tools, by extending the exported `AgentApiController` / `AgentUiController` under your
   * own path and decorators (the module exports what they inject). Static wiring.
   */
  routes?: boolean;
  /** Extra `imports` merged into the console's modules — what a decorator's guard injects. */
  imports?: DynamicModule['imports'];
  /**
   * OVERRIDE for WHO is deciding a HITL approval — invoked on the incoming
   * `POST <api>/approvals/:toolCallId` request to stamp `AgentApprovalPort`'s `opts.executedByRef`.
   *
   * DEFAULT (option omitted): the AgentModule-configured actor resolver (`AGENT_ACTOR_RESOLVER`) is
   * consulted — the same identity seam chat requests use — and its actor id becomes the decider ref
   * (a throwing resolver, i.e. an unauthenticated request, just omits the ref). Set this only when
   * the console's caller is identified differently from chat's; returning `undefined` leaves
   * `executedByRef` unset — the explicit override wins outright, with no resolver fallback.
   */
  approvalActorRef?: (req: TReq) => string | undefined;
}

/** Leading slash, no trailing slash. */
function normalize(path: string): string {
  return normalizeDashboardPath(path);
}

/**
 * Refuse to serve a governance console open in production: either decorators state who reaches it,
 * or the app mounts the routes itself.
 */
function assertProtected(options: AgentDashboardOptions<unknown>): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (options.routes === false) return;
  if ((options.decorators ?? []).length > 0) return;
  throw new Error(
    'AgentDashboardModule: the AI-gateway console would be served open in production. Say who reaches it, with ' +
      "`decorators: [UseGuards(AuthenticationGuard), Can(ConsolePolicy, 'view')]`, or mount its routes yourself " +
      'with `routes: false` and extend `AgentApiController` / `AgentUiController` under your own guards.',
  );
}

/** Holds the JSON API + SSE controller and its read service, mounted on its own path. */
@Module({})
export class AgentApiModule {
  static register<TReq = unknown>(options: {
    imports?: DynamicModule['imports'];
    decorators?: ClassDecorator[];
    routes?: boolean;
    approvalActorRef?: (req: TReq) => string | undefined;
  }): DynamicModule {
    return {
      module: AgentApiModule,
      imports: [...(options.imports ?? [])],
      controllers:
        options.routes === false
          ? []
          : withControllerDecorators([AgentApiController], options.decorators),
      providers: [
        DashboardService,
        // `useValue` even when `options.approvalActorRef` is `undefined` — AgentApiController
        // injects this WITHOUT `@Optional()`.
        { provide: DASHBOARD_APPROVAL_ACTOR_REF, useValue: options.approvalActorRef },
      ],
      // What a self-mounted `AgentApiController` subclass injects, too (`routes: false`).
      exports: [DashboardService, DASHBOARD_APPROVAL_ACTOR_REF],
    };
  }
}

/**
 * The AI-gateway console: the SPA at `basePath` and its JSON API at `apiBasePath`. Who reaches them
 * is the app's — `decorators`, or the app mounts them itself (`routes: false`) — with
 * `@nestjs/authentication` / `@nestjs/authorization`.
 */
@Module({})
export class AgentDashboardModule {
  static forRoot<TReq = unknown>(options: AgentDashboardOptions<TReq> = {}): DynamicModule {
    assertProtected(options as AgentDashboardOptions<unknown>);
    const basePath = normalize(options.basePath ?? '/ai-gateway');
    const apiBasePath = normalize(options.apiBasePath ?? `${basePath}/api`);
    return {
      module: AgentDashboardModule,
      imports: [
        ...(options.imports ?? []),
        // Spread-only-when-set: exactOptionalPropertyTypes rejects an explicit `undefined`.
        AgentApiModule.register({
          ...(options.imports ? { imports: options.imports } : {}),
          ...(options.decorators ? { decorators: options.decorators } : {}),
          ...(options.routes === false ? { routes: false } : {}),
          ...(options.approvalActorRef ? { approvalActorRef: options.approvalActorRef } : {}),
        }),
        ...(options.routes === false
          ? []
          : [
              RouterModule.register([
                { path: basePath, module: AgentDashboardModule },
                { path: apiBasePath, module: AgentApiModule },
              ]),
            ]),
      ],
      controllers:
        options.routes === false
          ? []
          : withControllerDecorators([AgentUiController], options.decorators),
      providers: [
        { provide: DASHBOARD_BASE_PATH, useValue: basePath },
        { provide: DASHBOARD_API_PATH, useValue: apiBasePath },
      ],
      // Re-export the API module so its DashboardService reaches importers (e.g. the host's own
      // controllers), and the paths a self-mounted `AgentUiController` subclass injects.
      exports: [AgentApiModule, DASHBOARD_BASE_PATH, DASHBOARD_API_PATH],
    };
  }
}
