import { normalizeDashboardPath } from './normalize-path.js';

/** Same shape {@link AgentDashboardModule.forRoot} accepts — kept local so this stays a pure, DI-free helper. */
export interface AgentDashboardMountPathsOptions {
  basePath?: string;
  apiBasePath?: string;
}

/** Strip the leading slash `normalizeDashboardPath` adds — `setGlobalPrefix`'s `exclude` roots are unprefixed. */
function unprefixed(path: string): string {
  return path.replace(/^\/+/, '');
}

/**
 * Route roots a host must EXCLUDE from a global prefix (`setGlobalPrefix('api', { exclude })`) so
 * the AI-gateway dashboard's SPA and JSON API keep resolving at their configured mount paths instead
 * of being shifted under the prefix.
 *
 * Unlike a single-surface dashboard (e.g. `telescopeMountPaths()`), this one mounts TWO route roots —
 * the UI at `basePath` and its JSON API at `apiBasePath` — so excluding only one leaves the other
 * shadowed. `options` mirrors {@link AgentDashboardOptions} and resolves through the exact same
 * defaulting (`apiBasePath` falls back to `<basePath>/api`) as {@link AgentDashboardModule.forRoot},
 * so the excluded roots always agree with what actually got mounted.
 *
 * @example
 * ```ts
 * // Raw defaults (basePath `/ai-gateway`, apiBasePath `/ai-gateway/api`):
 * app.setGlobalPrefix('api', { exclude: agentDashboardMountPaths() });
 * // -> ['ai-gateway', 'ai-gateway/{*splat}', 'ai-gateway/api', 'ai-gateway/api/{*splat}']
 *
 * // The recommended pattern — apiBasePath nested under the app's own `/api` prefix — MUST pass the
 * // same options given to `forRoot(...)`:
 * const dashboardOptions = { apiBasePath: '/api/ai-gateway' };
 * app.setGlobalPrefix('api', { exclude: agentDashboardMountPaths(dashboardOptions) });
 * // -> ['ai-gateway', 'ai-gateway/{*splat}', 'api/ai-gateway', 'api/ai-gateway/{*splat}']
 * ```
 */
export function agentDashboardMountPaths(options?: AgentDashboardMountPathsOptions): string[] {
  const basePath = normalizeDashboardPath(options?.basePath ?? '/ai-gateway');
  const apiBasePath = normalizeDashboardPath(options?.apiBasePath ?? `${basePath}/api`);
  const base = unprefixed(basePath);
  const api = unprefixed(apiBasePath);
  return [base, `${base}/{*splat}`, api, `${api}/{*splat}`];
}
