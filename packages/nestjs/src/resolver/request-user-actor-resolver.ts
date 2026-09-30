import type { Actor, ActorResolver } from '@dudousxd/nestjs-agent-core';
import { UnauthorizedException } from '@nestjs/common';

/** Turns whatever your auth put on `req.user` into the agent's {@link Actor}. */
export type RequestUserMapper<TUser = Record<string, unknown>> = (
  user: TUser,
  req: unknown,
) => Actor | Promise<Actor>;

function field(user: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    const value = user[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

/**
 * The default mapping: `id` from `id` / `sub` / `_id` / `userId`, `roles` from `roles` (an array)
 * or `role` (a string), `tenantRef` from `tenantRef` / `tenantId` / `orgId`.
 */
export function defaultRequestUserMapper(user: Record<string, unknown>): Actor {
  const id = field(user, 'id', 'sub', '_id', 'userId');
  if (id === undefined) {
    throw new UnauthorizedException(
      'requestUserActorResolver: req.user has no id/sub/_id/userId — pass a mapper: ' +
        'requestUserActorResolver((user) => ({ id: …, roles: … }))',
    );
  }
  const rawRoles = field(user, 'roles', 'role');
  const roles = Array.isArray(rawRoles)
    ? rawRoles.map(String)
    : typeof rawRoles === 'string'
      ? [rawRoles]
      : [];
  const tenant = field(user, 'tenantRef', 'tenantId', 'orgId');
  return {
    id: String(id),
    roles,
    ...(tenant !== undefined ? { tenantRef: String(tenant) } : {}),
  };
}

/**
 * Authenticated mode in one line, for apps whose auth already puts the principal on `req.user` —
 * Passport strategies, `express-session` / cookie-session middleware, a Nest guard that assigns it:
 *
 * ```ts
 * AgentModule.forRoot({ model, actorResolver: requestUserActorResolver() })
 * ```
 *
 * A request without `req.user` is refused with `401` — the agent never invents a caller. Pass a
 * mapper when your user object is shaped differently:
 *
 * ```ts
 * requestUserActorResolver((user: SessionUser) => ({ id: user.uuid, roles: user.permissions }))
 * ```
 */
export function requestUserActorResolver<TUser = Record<string, unknown>>(
  map?: RequestUserMapper<TUser>,
): ActorResolver {
  return {
    async resolve(req: unknown): Promise<Actor> {
      const user =
        typeof req === 'object' && req !== null ? (req as { user?: unknown }).user : undefined;
      if (user === undefined || user === null || user === false) {
        throw new UnauthorizedException('Sign in to use the agent.');
      }
      if (map !== undefined) return map(user as TUser, req);
      return defaultRequestUserMapper(user as Record<string, unknown>);
    },
  };
}
