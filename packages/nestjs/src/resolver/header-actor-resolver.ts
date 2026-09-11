import type { Actor, ActorResolver } from '@dudousxd/nestjs-agent-core';
import { UnauthorizedException } from '@nestjs/common';

/** Read a string header off an unknown transport request, narrowing without trusting its shape. */
function readHeader(req: unknown, name: string): string | undefined {
  if (typeof req !== 'object' || req === null || !('headers' in req)) return undefined;
  const { headers } = req;
  if (typeof headers !== 'object' || headers === null || !(name in headers)) return undefined;
  const value: unknown = Reflect.get(headers, name);
  return typeof value === 'string' ? value : undefined;
}

/**
 * A development / gateway {@link ActorResolver} that trusts request headers:
 * `x-actor-id` (required), `x-actor-role` (comma-separated → `roles`), `x-tenant-ref`.
 *
 * **Security:** it rejects with `UnauthorizedException` when `x-actor-id` is absent — it never
 * fabricates an identity, and never grants a default role (an actor with no `x-actor-role` gets
 * `roles: []`, i.e. no tools). Trusting client headers is only safe behind a gateway that strips
 * and re-sets them from an authenticated principal. Real deployments should provide their own resolver
 * that reads a verified session/JWT instead of installing this one. A custom resolver should
 * reject the same way: a plain `Error` surfaces to the caller as a 500 with a logged stack, which
 * both misreports an unauthenticated request and turns anonymous probes into error noise.
 */
export class HeaderActorResolver implements ActorResolver {
  resolve(req: unknown): Actor {
    const id = readHeader(req, 'x-actor-id');
    if (id === undefined || id.length === 0) {
      throw new UnauthorizedException(
        'HeaderActorResolver: missing x-actor-id header. No default actor is fabricated. ' +
          'Send x-actor-id from a trusted gateway, or configure ' +
          'AgentModule.forRoot({ actorResolver }) with a resolver that reads your ' +
          'authenticated principal.',
      );
    }
    const roles = (readHeader(req, 'x-actor-role') ?? '')
      .split(',')
      .map((role) => role.trim())
      .filter((role) => role.length > 0);
    const tenantRef = readHeader(req, 'x-tenant-ref');
    return {
      id,
      roles,
      ...(tenantRef !== undefined ? { tenantRef } : {}),
    };
  }
}
