import { type DynamicModule, Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { AgentApiController } from './agent-api.controller.js';
import { AgentUiController } from './agent-ui.controller.js';
import { DashboardService } from './dashboard.service.js';
import { DASHBOARD_API_PATH, DASHBOARD_BASE_PATH } from './tokens.js';

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
}

/** Leading slash, no trailing slash. */
function normalize(path: string): string {
  return `/${path.replace(/^\/+|\/+$/g, '')}`;
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
 * routes with your own guard — the controllers are path-relative and guard-frontable.
 */
@Module({})
export class AgentDashboardModule {
  static forRoot(options: AgentDashboardOptions = {}): DynamicModule {
    const basePath = normalize(options.basePath ?? '/ai-gateway');
    const apiBasePath = normalize(options.apiBasePath ?? `${basePath}/api`);
    return {
      module: AgentDashboardModule,
      imports: [
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
