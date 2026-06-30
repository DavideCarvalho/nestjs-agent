import type { Actor } from '@dudousxd/nestjs-agent-core';

interface HeaderBag {
  headers: Record<string, unknown>;
}

function header(req: HeaderBag, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Resolves the acting user for a request. The default reads `x-actor-id` / `x-actor-role` /
 * `x-tenant-ref` headers (handy for the demo and curl). Real apps should replace this by
 * wiring `@dudousxd/nestjs-context` and passing the resolved actor into `AgentService`.
 */
export function resolveActor(req: HeaderBag): Actor {
  const id = header(req, 'x-actor-id') ?? 'demo-user';
  const role = header(req, 'x-actor-role') ?? 'ADMIN';
  const tenantRef = header(req, 'x-tenant-ref');
  return {
    id,
    role,
    ...(tenantRef !== undefined ? { tenantRef } : {}),
  };
}
