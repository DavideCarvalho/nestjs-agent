import 'reflect-metadata';
import { type CanActivate, type DynamicModule, Module, type Type } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { AgentApiController } from './agent-api.controller.js';
import { AgentUiController } from './agent-ui.controller.js';
import { DashboardService } from './dashboard.service.js';
import { normalizeDashboardPath } from './normalize-path.js';
import { DASHBOARD_API_PATH, DASHBOARD_BASE_PATH } from './tokens.js';

/**
 * `@nestjs/common`'s own `GUARDS_METADATA` key, INLINED rather than deep-imported from
 * '@nestjs/common/constants' — that subpath has no extension and a strict ESM resolver (which the
 * built dual ESM/CJS output of this package is loaded under) 404s on it. A drift spec imports the
 * real constant (via the resolvable `'@nestjs/common/constants.js'` subpath) and asserts this literal
 * stays byte-identical to it.
 */
const GUARDS_METADATA = '__guards__';

export interface AgentDashboardOptions {
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
   * `apiBasePath`). Stamped onto each controller via `@nestjs/common`'s own `@UseGuards` metadata key
   * — REPLACE semantics, so a second `forRoot(...)` call overwrites (not appends to) whatever a prior
   * call stamped, same as re-applying `@UseGuards` by hand. Omit to leave the routes unguarded (the
   * host fronts them another way, e.g. a global guard or reverse-proxy auth).
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
}

/** Leading slash, no trailing slash. */
function normalize(path: string): string {
  return normalizeDashboardPath(path);
}

/** Stamp (or clear) `@UseGuards`-equivalent metadata on the dashboard controllers — REPLACE, not append. */
function stampGuards(guards: Type<CanActivate>[] | undefined, ...controllers: Type[]): void {
  for (const controller of controllers) {
    Reflect.defineMetadata(GUARDS_METADATA, guards ?? [], controller);
  }
}

/** Holds the JSON API + SSE controller and its read service, mounted on its own path by `forRoot`. */
@Module({
  controllers: [AgentApiController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class AgentApiModule {}

/**
 * Mounts the AI-gateway governance console: the bundled React SPA at `basePath` and its JSON + SSE
 * API at `apiBasePath` (default `<basePath>/api`).
 *
 * Import via `AgentDashboardModule.forRoot(...)` alongside your `@dudousxd/nestjs-agent` module
 * (global), which must provide `AGENT_GOVERNANCE_QUERIES` (bound by a store adapter). Front the
 * routes with the first-class `guards` option (plus `imports` for the guards' own dependencies) —
 * see {@link AgentDashboardOptions.guards}.
 */
@Module({})
export class AgentDashboardModule {
  static forRoot(options: AgentDashboardOptions = {}): DynamicModule {
    const basePath = normalize(options.basePath ?? '/ai-gateway');
    const apiBasePath = normalize(options.apiBasePath ?? `${basePath}/api`);
    stampGuards(options.guards, AgentApiController, AgentUiController);
    return {
      module: AgentDashboardModule,
      imports: [
        ...(options.imports ?? []),
        AgentApiModule,
        RouterModule.register([
          { path: basePath, module: AgentDashboardModule }, // the UI controller below
          { path: apiBasePath, module: AgentApiModule },
        ]),
      ],
      controllers: [AgentUiController],
      providers: [
        { provide: DASHBOARD_BASE_PATH, useValue: basePath },
        { provide: DASHBOARD_API_PATH, useValue: apiBasePath },
      ],
      // Re-export the API module so its DashboardService reaches importers (e.g. the host's own controllers).
      exports: [AgentApiModule],
    };
  }
}
