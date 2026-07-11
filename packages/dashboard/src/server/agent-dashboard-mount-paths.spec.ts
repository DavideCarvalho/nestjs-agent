import { describe, expect, it } from 'vitest';
import { agentDashboardMountPaths } from './agent-dashboard-mount-paths.js';

describe('agentDashboardMountPaths', () => {
  it('defaults to /ai-gateway (UI) and /ai-gateway/api (API) — the module forRoot() defaults', () => {
    expect(agentDashboardMountPaths()).toEqual([
      'ai-gateway',
      'ai-gateway/{*splat}',
      'ai-gateway/api',
      'ai-gateway/api/{*splat}',
    ]);
  });

  it('honors a custom apiBasePath (the recommended `/api/ai-gateway` nesting)', () => {
    expect(agentDashboardMountPaths({ apiBasePath: '/api/ai-gateway' })).toEqual([
      'ai-gateway',
      'ai-gateway/{*splat}',
      'api/ai-gateway',
      'api/ai-gateway/{*splat}',
    ]);
  });

  it('honors a custom basePath, re-deriving the default apiBasePath from it', () => {
    expect(agentDashboardMountPaths({ basePath: '/admin/ai' })).toEqual([
      'admin/ai',
      'admin/ai/{*splat}',
      'admin/ai/api',
      'admin/ai/api/{*splat}',
    ]);
  });

  it('honors both a custom basePath and apiBasePath together', () => {
    expect(agentDashboardMountPaths({ basePath: '/console', apiBasePath: '/api/console' })).toEqual(
      ['console', 'console/{*splat}', 'api/console', 'api/console/{*splat}'],
    );
  });

  it('normalizes leading/trailing slashes like the module does', () => {
    expect(agentDashboardMountPaths({ basePath: '/ai-gateway/' })).toEqual(
      agentDashboardMountPaths(),
    );
    expect(agentDashboardMountPaths({ basePath: '///ai-gateway///' })).toEqual(
      agentDashboardMountPaths(),
    );
  });
});
