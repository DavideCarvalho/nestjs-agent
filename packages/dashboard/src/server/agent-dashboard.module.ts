import { withControllerDecorators } from '@dudousxd/nestjs-agent-core';
import 'reflect-metadata';
import { type DynamicModule, Module, UseFilters, UseGuards } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { AgentApiController } from './agent-api.controller.js';
import { AgentUiController } from './agent-ui.controller.js';
import {
  ConsoleAuthorizeFilter,
  ConsoleAuthorizeGuard,
  DashboardConsoleAccess,
  type DashboardConsoleOptions,
} from './console-authorize.guard.js';
import type { ConsoleAuthorize } from './console-authorize.js';
import type { ConsoleSignOutOption, ConsoleViewerResolver } from './console-shell.js';
import { AgentConsoleRegistration, AgentConsolesController } from './console-switcher.js';
import { DashboardService } from './dashboard.service.js';
import { AgentDevToolsRegistration } from './dev-tools.js';
import { normalizeDashboardPath } from './normalize-path.js';
import {
  DASHBOARD_API_PATH,
  DASHBOARD_APPROVAL_ACTOR_REF,
  DASHBOARD_BASE_PATH,
  DASHBOARD_CONSOLE_OPTIONS,
  DASHBOARD_DEV_TOOLS,
  DASHBOARD_SHELL,
} from './tokens.js';

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
   * Who reaches the console (the SPA and every API/SSE route): an inline function
   * `(ctx) => boolean | { allowed } | { redirectTo }`, an `@Injectable()` `ConsoleAuthorizer` class,
   * a lazy import of one, `{ policy, ability }` (`@nestjs/authorization`), or a gate name
   * (`@dudousxd/nestjs-authz`). `authorizeByToken({ token })` checks a bearer token.
   *
   * Omitted: open outside production; in production every request answers 403 (and a warning is
   * logged at boot).
   */
  authorize?: ConsoleAuthorize;
  /**
   * Class decorators applied to every controller this module mounts, before the console's own
   * `authorize` check — e.g. `[UseGuards(AuthenticationGuard)]` so `request.user` is set when
   * `authorize` runs. Applied to a per-registration subclass, so nothing sticks to the shared
   * classes. They do not replace `authorize`. Static wiring.
   */
  decorators?: ClassDecorator[];
  /**
   * `false` mounts none of the console's routes, while its services still run — the way NestJS's
   * own packages leave routes to you: serve them from controllers of your own, protected with the
   * official tools, by extending the exported `AgentApiController` / `AgentUiController` under your
   * own path and decorators (the module exports what they inject); `UseConsoleAuthorize()` applies
   * this module's `authorize` to them. Static wiring.
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
  /**
   * Register the console's reads as developer tools on the agent MCP server's dev endpoint
   * (`/mcp/aviary`), gated by this console's `authorize`. Default: on when the console's routes are
   * mounted, off with `routes: false`.
   */
  devTools?: boolean;
  /**
   * Who the console's sidebar footer says is signed in: `(request) => ({ label, email?, role? })`,
   * sync or async. `null`/`undefined` or a throw shows no user row.
   *
   * Omitted: `request.user` is read structurally — whatever your guards (`decorators`) already put
   * there: `fullName` → `name` → `email` for the label, and `role` or the first of `roles` (a
   * string or `{ name }`). Reading it never triggers an authentication.
   */
  viewer?: ConsoleViewerResolver;
  /**
   * The sidebar footer's sign-out. One of:
   *
   * - `'/logout'`: a POST form to that path (with `_csrf` when the request exposes
   *   `req.csrfToken()`);
   * - `{ href: '/logout' }`: a plain link;
   * - `{ action: '/logout', csrfToken: (request) => token }`: a POST form with your token as `_csrf`;
   * - `false`: none, even when an account console announced one.
   *
   * Omitted: the sign-out an account console announced on the Aviary consoles registry
   * (`account.signOut`), else none. Only same-origin paths (`/x`) are ever sent to the page.
   */
  signOut?: ConsoleSignOutOption;
}

/** Leading slash, no trailing slash. */
function normalize(path: string): string {
  return normalizeDashboardPath(path);
}

/** The decorators every mounted controller gets: the app's, then the console's access check. */
function consoleDecorators(decorators: ClassDecorator[] | undefined): ClassDecorator[] {
  return [
    ...(decorators ?? []),
    UseGuards(ConsoleAuthorizeGuard),
    UseFilters(ConsoleAuthorizeFilter),
  ];
}

/** Holds the JSON API + SSE controller and its read service, mounted on its own path. */
@Module({})
export class AgentApiModule {
  static register<TReq = unknown>(options: {
    imports?: DynamicModule['imports'];
    decorators?: ClassDecorator[];
    routes?: boolean;
    approvalActorRef?: (req: TReq) => string | undefined;
    authorize?: ConsoleAuthorize;
    devTools?: boolean;
  }): DynamicModule {
    // The warning for an omitted `authorize` logs with `routes: false` too: the exported guard still
    // answers 403 in production.
    const consoleOptions: DashboardConsoleOptions = {
      ...(options.authorize !== undefined ? { authorize: options.authorize } : {}),
    };
    return {
      module: AgentApiModule,
      imports: [...(options.imports ?? [])],
      controllers:
        options.routes === false
          ? []
          : withControllerDecorators(
              [AgentApiController, AgentConsolesController],
              consoleDecorators(options.decorators),
            ),
      providers: [
        DashboardService,
        // `useValue` even when `options.approvalActorRef` is `undefined` — AgentApiController
        // injects this WITHOUT `@Optional()`.
        { provide: DASHBOARD_APPROVAL_ACTOR_REF, useValue: options.approvalActorRef },
        { provide: DASHBOARD_CONSOLE_OPTIONS, useValue: consoleOptions },
        DashboardConsoleAccess,
        { provide: DASHBOARD_DEV_TOOLS, useValue: options.devTools ?? options.routes !== false },
        AgentDevToolsRegistration,
      ],
      // What a self-mounted `AgentApiController` subclass injects, too (`routes: false`), and the
      // access check `UseConsoleAuthorize()` runs.
      exports: [DashboardService, DASHBOARD_APPROVAL_ACTOR_REF, DashboardConsoleAccess],
    };
  }
}

/**
 * The AI-gateway console: the SPA at `basePath` and its JSON API at `apiBasePath`. Who reaches them
 * is `authorize` (see {@link AgentDashboardOptions.authorize}).
 */
@Module({})
export class AgentDashboardModule {
  static forRoot<TReq = unknown>(options: AgentDashboardOptions<TReq> = {}): DynamicModule {
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
          ...(options.authorize !== undefined ? { authorize: options.authorize } : {}),
          ...(options.devTools !== undefined ? { devTools: options.devTools } : {}),
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
          : withControllerDecorators([AgentUiController], consoleDecorators(options.decorators)),
      providers: [
        { provide: DASHBOARD_BASE_PATH, useValue: basePath },
        { provide: DASHBOARD_API_PATH, useValue: apiBasePath },
        {
          provide: DASHBOARD_SHELL,
          useValue: {
            ...(options.viewer ? { viewer: options.viewer } : {}),
            ...(options.signOut !== undefined ? { signOut: options.signOut } : {}),
          },
        },
        // The console switcher lists this console only where it serves its own page.
        ...(options.routes === false ? [] : [AgentConsoleRegistration]),
      ],
      // Re-export the API module so its DashboardService reaches importers (e.g. the host's own
      // controllers), and the paths and shell options a self-mounted `AgentUiController` subclass
      // injects.
      exports: [AgentApiModule, DASHBOARD_BASE_PATH, DASHBOARD_API_PATH, DASHBOARD_SHELL],
    };
  }
}
