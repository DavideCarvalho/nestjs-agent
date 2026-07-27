import 'reflect-metadata';
import {
  type CanActivate,
  type DynamicModule,
  type InjectionToken,
  Module,
  type OptionalFactoryDependency,
  type Provider,
  type Type,
} from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { AgentApiController } from './agent-api.controller.js';
import { AgentDashboardAuthController } from './agent-dashboard-auth.controller.js';
import { AgentUiController } from './agent-ui.controller.js';
import type { DashboardAuthOptions } from './auth/dashboard-auth-config.js';
import { resolveDashboardAuth } from './auth/dashboard-auth-config.js';
import { DashboardAuthPageGuard } from './auth/dashboard-auth-page.guard.js';
import { DashboardAuthGuard } from './auth/dashboard-auth.guard.js';
import { DashboardService } from './dashboard.service.js';
import { baseGuards, isGuardClass, stampGuards } from './guards.js';
import { normalizeDashboardPath } from './normalize-path.js';
import {
  DASHBOARD_API_PATH,
  DASHBOARD_APPROVAL_ACTOR_REF,
  DASHBOARD_AUTH,
  DASHBOARD_BASE_PATH,
} from './tokens.js';

/**
 * `AgentApiController`/`AgentUiController`'s own, pristine `@UseGuards(...)` metadata — the
 * built-in `dashboardAuth` guard, always present — captured once at module-load time. Every
 * `stampGuards` call below appends host `guards` onto THIS baseline (never onto whatever a prior
 * `forRoot`/`forRootAsync` call last stamped), so repeated calls in the same process never compound
 * (see `./guards.ts`).
 */
const API_BASE_GUARDS = baseGuards(AgentApiController);
const UI_BASE_GUARDS = baseGuards(AgentUiController);

/**
 * `TReq` mirrors core's `ActorResolver<TReq>` convention: the transport request type
 * {@link AgentDashboardOptions.approvalActorRef} receives. Defaults to `unknown` so untyped usage
 * compiles unchanged; a host may narrow it (e.g. `forRoot<Request>({ approvalActorRef: ... })`)
 * instead of writing its own `unknown`-narrowing type guard.
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
   * Guard classes fronting BOTH dashboard controllers (the SPA at `basePath` and its JSON API at
   * `apiBasePath`) — APPENDED onto the built-in `dashboardAuth` gate (a no-op unless configured;
   * see {@link dashboardAuth}), so a request must pass BOTH. Omit to leave the routes gated by
   * `dashboardAuth` alone (or fully open when that's unset too).
   *
   * A guard's own DEPENDENCIES resolve from this module's `imports` (see {@link imports}) — the
   * dashboard module has no application context of its own to pull them from otherwise.
   */
  guards?: Type<CanActivate>[];
  /**
   * Extra `imports` merged into the dashboard's dynamic module — the DI resolution path for a class
   * passed to {@link guards} (or any other provider the controllers need reachable). Typically the
   * host's own auth module, e.g. `imports: [AuthModule]` alongside `guards: [JwtAuthGuard]`.
   */
  imports?: DynamicModule['imports'];
  /**
   * OVERRIDE for WHO is deciding a HITL approval — invoked on the incoming
   * `POST <api>/approvals/:toolCallId` request to stamp `AgentApprovalPort`'s `opts.executedByRef`.
   *
   * DEFAULT (option omitted): the AgentModule-configured actor resolver (`AGENT_ACTOR_RESOLVER`) is
   * consulted — the same identity seam chat requests use — and its actor id becomes the decider ref
   * (a throwing resolver, i.e. an unauthenticated request, just omits the ref). Set this only when
   * console auth differs from chat auth (e.g. the console sits behind a separate SSO whose principal
   * the chat resolver can't read); returning `undefined` leaves `executedByRef` unset — the explicit
   * override wins outright, with no resolver fallback.
   */
  approvalActorRef?: (req: TReq) => string | undefined;
  /**
   * Gate the console (SPA + API) behind a built-in, signed session cookie. Two ways to mint it:
   *
   * - **Mode A (`session`, recommended)**: your host app already has its own auth (SSO/OIDC/
   *   whatever) — the host frontend, carrying that auth, POSTs to `<basePath>/auth/session`, your
   *   `session` hook validates the raw request and returns the session user, and this library
   *   mints its cookie from that. No credential this library understands ever exists; you keep
   *   your own identity provider as the source of truth. A page-level request with no valid
   *   session (and only Mode A configured) gets a small server-rendered instruction page telling
   *   the visitor to sign in through your host app, since there is no login page to redirect to.
   * - **Mode B (`login`, standalone fallback)**: no host frontend/IdP to lean on — the console
   *   serves its own small, dependency-free, server-rendered login page (`GET
   *   <basePath>/auth/login`) and your `login` hook validates submitted username/password. A
   *   missing/invalid/expired session redirects a page-level request to that login page with
   *   `?returnTo=<original url>`.
   *
   * Either mode can be used alone, or both together (e.g. Mode A for normal use, Mode B as a
   * break-glass fallback) — at least one is required, or `forRoot`/`forRootAsync` throws at boot
   * (an un-mintable gate is a boot error, not a silently-open or silently-stuck console). An
   * unauthenticated API call always gets a plain `401`, regardless of mode — the caller reads the
   * status code, not HTML. Composes with `guards` — BOTH gates must pass. See
   * `DashboardAuthOptions` for the `secret`/`ttl`/`session`/`login` shape.
   */
  dashboardAuth?: DashboardAuthOptions;
}

/**
 * Async variant of {@link AgentDashboardOptions}, for a `session`/`login` hook that needs injected
 * services (e.g. an EntityManager to check credentials against a DB). Everything else stays
 * static/sync — `basePath`/`apiBasePath`/`guards` are needed at module-build time (the same
 * constraint `@dudousxd/nestjs-telescope`'s and `@dudousxd/nestjs-media`'s own `forRootAsync`s
 * document), so only the auth piece itself is resolved through DI.
 */
export interface AgentDashboardAsyncOptions<TReq = unknown> {
  basePath?: string;
  apiBasePath?: string;
  guards?: Type<CanActivate>[];
  imports?: DynamicModule['imports'];
  approvalActorRef?: (req: TReq) => string | undefined;
  /** Providers injected into `useDashboardAuth`, in order. Shared with a guard class's own deps via `imports`. */
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  /**
   * Build the `dashboardAuth` config from injected deps, or return `undefined` to leave the
   * console open (or fronted only by `guards`). See {@link AgentDashboardOptions.dashboardAuth}.
   */
  useDashboardAuth: (
    ...deps: any[]
  ) => DashboardAuthOptions | undefined | Promise<DashboardAuthOptions | undefined>;
}

/** Leading slash, no trailing slash. */
function normalize(path: string): string {
  return normalizeDashboardPath(path);
}

/**
 * Holds the JSON API + SSE controller and its read service, mounted on its own path by `forRoot`.
 * Dynamic: guards are DI-instantiated by the CONTROLLER's host module, so this module — not the
 * outer wrapper — must carry the guard classes as providers plus the host's `imports` that resolve
 * their dependencies. A static module here made `guards: [SomeGuardWithDeps]` fail at boot with
 * "Nest can't resolve dependencies ... in the AgentApiModule context" even when the host passed
 * the right `imports` to `forRoot`.
 */
@Module({})
export class AgentApiModule {
  static register<TReq = unknown>(options: {
    imports?: DynamicModule['imports'];
    guards?: Type<CanActivate>[];
    approvalActorRef?: (req: TReq) => string | undefined;
    /** Provider for `DASHBOARD_AUTH` — a `useValue` (`forRoot`) or a `useFactory` (`forRootAsync`). */
    dashboardAuth: Provider;
  }): DynamicModule {
    stampGuards(options.guards, [[AgentApiController, API_BASE_GUARDS]]);
    return {
      module: AgentApiModule,
      imports: [...(options.imports ?? [])],
      controllers: [AgentApiController],
      providers: [
        DashboardService,
        DashboardAuthGuard,
        options.dashboardAuth,
        ...(options.guards ?? []).filter(isGuardClass),
        // `useValue` even when `options.approvalActorRef` is `undefined` — AgentApiController
        // injects this WITHOUT `@Optional()` (same pattern as `AGENT_QUOTA_STORE`'s factory).
        { provide: DASHBOARD_APPROVAL_ACTOR_REF, useValue: options.approvalActorRef },
      ],
      // DASHBOARD_AUTH re-exported so AgentUiController/AgentDashboardAuthController (hosted
      // directly by AgentDashboardModule, which imports this module) resolve the SAME instance
      // instead of re-running a host's async factory a second time.
      exports: [DashboardService, DASHBOARD_AUTH],
    };
  }
}

/**
 * Mounts the AI-gateway governance console: the bundled React SPA at `basePath` and its JSON + SSE
 * API at `apiBasePath` (default `<basePath>/api`), plus the built-in `dashboardAuth` routes at
 * `<basePath>/auth/*` when {@link AgentDashboardOptions.dashboardAuth} is set — `POST
 * <basePath>/auth/session` for Mode A (the host mints the session from its own auth) and/or `GET`/
 * `POST <basePath>/auth/login` for Mode B (the built-in login screen).
 *
 * Import via `AgentDashboardModule.forRoot(...)` alongside your `@dudousxd/nestjs-agent` module
 * (global), which must provide `AGENT_GOVERNANCE_QUERIES` (bound by a store adapter). Front the
 * routes with the first-class `guards` option (plus `imports` for the guards' own dependencies) —
 * see {@link AgentDashboardOptions.guards} — and/or the built-in `dashboardAuth` session cookie.
 *
 * Inertia hosts: the console is a full-page app, not an Inertia page. An in-app `<Link>` visit to
 * `basePath` (an XHR carrying `X-Inertia`) is bounced with the protocol's own external-redirect
 * mechanism — `409 Conflict` + `X-Inertia-Location: <the visited URL>` — so the Inertia client
 * performs a full `window.location` load and the console renders normally. In-app links to the
 * console therefore just work; no host-side special-casing needed.
 */
@Module({})
export class AgentDashboardModule {
  static forRoot<TReq = unknown>(options: AgentDashboardOptions<TReq> = {}): DynamicModule {
    const basePath = normalize(options.basePath ?? '/ai-gateway');
    const apiBasePath = normalize(options.apiBasePath ?? `${basePath}/api`);
    stampGuards(options.guards, [[AgentUiController, UI_BASE_GUARDS]]);
    const dashboardAuthProvider: Provider = {
      provide: DASHBOARD_AUTH,
      useValue: resolveDashboardAuth(options.dashboardAuth),
    };
    return {
      module: AgentDashboardModule,
      imports: [
        ...(options.imports ?? []),
        // Guards + host imports must reach the API controller's HOST module — enhancers resolve
        // from their controller's own module, never from a parent (see AgentApiModule.register).
        // Spread-only-when-set: exactOptionalPropertyTypes rejects an explicit `undefined`.
        AgentApiModule.register({
          ...(options.imports ? { imports: options.imports } : {}),
          ...(options.guards ? { guards: options.guards } : {}),
          ...(options.approvalActorRef ? { approvalActorRef: options.approvalActorRef } : {}),
          dashboardAuth: dashboardAuthProvider,
        }),
        RouterModule.register([
          { path: basePath, module: AgentDashboardModule }, // the UI + auth controllers below
          { path: apiBasePath, module: AgentApiModule },
        ]),
      ],
      controllers: [AgentUiController, AgentDashboardAuthController],
      providers: [
        { provide: DASHBOARD_BASE_PATH, useValue: basePath },
        { provide: DASHBOARD_API_PATH, useValue: apiBasePath },
        DashboardAuthPageGuard,
        // AgentUiController is hosted HERE, so its guards DI-instantiate from this module.
        ...(options.guards ?? []).filter(isGuardClass),
      ],
      // Re-export the API module so its DashboardService reaches importers (e.g. the host's own controllers).
      exports: [AgentApiModule],
    };
  }

  static forRootAsync<TReq = unknown>(options: AgentDashboardAsyncOptions<TReq>): DynamicModule {
    const basePath = normalize(options.basePath ?? '/ai-gateway');
    const apiBasePath = normalize(options.apiBasePath ?? `${basePath}/api`);
    stampGuards(options.guards, [[AgentUiController, UI_BASE_GUARDS]]);
    const dashboardAuthProvider: Provider = {
      provide: DASHBOARD_AUTH,
      inject: options.inject ?? [],
      useFactory: async (...deps: unknown[]) =>
        resolveDashboardAuth(await options.useDashboardAuth(...deps)),
    };
    return {
      module: AgentDashboardModule,
      imports: [
        ...(options.imports ?? []),
        AgentApiModule.register({
          ...(options.imports ? { imports: options.imports } : {}),
          ...(options.guards ? { guards: options.guards } : {}),
          ...(options.approvalActorRef ? { approvalActorRef: options.approvalActorRef } : {}),
          dashboardAuth: dashboardAuthProvider,
        }),
        RouterModule.register([
          { path: basePath, module: AgentDashboardModule },
          { path: apiBasePath, module: AgentApiModule },
        ]),
      ],
      controllers: [AgentUiController, AgentDashboardAuthController],
      providers: [
        { provide: DASHBOARD_BASE_PATH, useValue: basePath },
        { provide: DASHBOARD_API_PATH, useValue: apiBasePath },
        DashboardAuthPageGuard,
        ...(options.guards ?? []).filter(isGuardClass),
      ],
      exports: [AgentApiModule],
    };
  }
}
