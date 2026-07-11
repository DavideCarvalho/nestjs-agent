/**
 * Leading slash, no trailing slash (`'ai-gateway/'` -> `'/ai-gateway'`). Shared by
 * {@link AgentDashboardModule.forRoot} and {@link agentDashboardMountPaths} so the mount-path math
 * behind the module and the pure helper that mirrors it can never drift apart.
 */
export function normalizeDashboardPath(path: string): string {
  return `/${path.replace(/^\/+|\/+$/g, '')}`;
}
