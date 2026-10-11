import {
  type Actor,
  type ActorResolver,
  PERSONAL_AGENT_ROLE,
  type PoppyAuthenticate,
  type PoppyPrincipal,
  globalPoppyAuthenticate,
  scopeRole,
} from '@dudousxd/nestjs-agent-core';
import { HttpException, HttpStatus } from '@nestjs/common';
import { McpChallengeException } from './mcp-challenge.js';
import { requestUrl } from './protected-resource.js';

/**
 * `actor` as a personal agent granted `scopes`: its roles plus `personal_agent` and one `scope:<id>`
 * per scope, so `personalAgentGate` applies — it is offered the tools written for personal agents
 * and runs only those of its scopes. For an app that verifies its personal agents' tokens itself.
 *
 * @experimental Part of the Personal Agent Protocol (Poppy, Draft 0.1) support.
 */
export function asPersonalAgent(actor: Actor, scopes: readonly string[]): Actor {
  return {
    ...actor,
    roles: [...new Set([...(actor.roles ?? []), PERSONAL_AGENT_ROLE, ...scopes.map(scopeRole)])],
  };
}

/** Options for {@link poppyActorResolver}. */
export interface PoppyActorResolverOptions {
  /** Your own Session Token verifier. Default: the one in {@link POPPY_AUTHENTICATE_SLOT}. */
  authenticate?: PoppyAuthenticate;
  /**
   * The MCP endpoint's public URL, handed to the verifier (DPoP `htu`, the token's `resource`).
   * Default: the request's own URL — set it behind a proxy that rewrites the scheme or host.
   */
  resource?: string;
  /**
   * The actor a signed-in principal acts as, when the authorization server did not answer one.
   * Default: `{ id: accountId }`. Whatever it returns becomes a personal agent of the token's scopes.
   */
  toActor?: (principal: PoppyPrincipal) => Actor | undefined | Promise<Actor | undefined>;
}

/** Read the headers off an unknown transport request. */
function headersOf(req: unknown): Record<string, string | string[] | undefined> {
  if (typeof req !== 'object' || req === null || !('headers' in req)) return {};
  const { headers } = req as { headers: unknown };
  return typeof headers === 'object' && headers !== null
    ? (headers as Record<string, string | string[] | undefined>)
    : {};
}

/**
 * An {@link ActorResolver} for the MCP tokens of Personal Agent Protocol (Poppy) sessions.
 *
 * Verifies the request's Bearer/DPoP Session Token with `authenticate` (default: the resolver
 * `@adonis-agora/authkit-server` installs in {@link POPPY_AUTHENTICATE_SLOT}) and answers the
 * principal's actor as a personal agent of the granted scopes ({@link asPersonalAgent}). Refusals
 * carry their challenge ({@link McpChallengeException}):
 *
 * - no token → `401` `Bearer`; a refused token → the verifier's status and challenge
 *   (`invalid_token`, `invalid_dpop_proof`, `use_dpop_nonce` with its `DPoP-Nonce`);
 * - a SIGNED-OUT Session's token → `403` `error="sign_in_required"` (Poppy §4.3): the token is valid
 *   but this server needs an account, and `invalid_token` would only make the agent mint another;
 * - no verifier at all → `501`: a deployment misconfiguration, not the caller's fault.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1; it WILL change as the spec evolves.
 */
export function poppyActorResolver(options: PoppyActorResolverOptions = {}): ActorResolver {
  return {
    async resolve(req: unknown): Promise<Actor> {
      const authenticate = options.authenticate ?? globalPoppyAuthenticate();
      if (authenticate === undefined) {
        throw new HttpException(
          'poppyActorResolver: no Poppy authenticate resolver — pass `authenticate`, or install @adonis-agora/authkit-server with Poppy on.',
          HttpStatus.NOT_IMPLEMENTED,
        );
      }
      const headers = headersOf(req);
      if (headers.authorization === undefined) {
        throw new McpChallengeException(401, { description: 'missing Session Token' });
      }
      const method = (req as { method?: unknown }).method;
      const result = await authenticate({
        method: typeof method === 'string' ? method : 'POST',
        url: options.resource ?? requestUrl(req),
        headers,
      });
      if (!result.ok) {
        throw new McpChallengeException(result.status, {
          error: result.error,
          wwwAuthenticate: result.wwwAuthenticate,
          ...(result.scope !== undefined ? { scope: result.scope } : {}),
          ...(result.description !== undefined ? { description: result.description } : {}),
          ...(result.headers !== undefined ? { headers: result.headers } : {}),
        });
      }
      const { principal } = result;
      const actor = principal.signedIn
        ? (principal.actor ??
          (await options.toActor?.(principal)) ??
          (principal.accountId !== null ? { id: principal.accountId } : undefined))
        : undefined;
      if (actor === undefined) {
        throw new McpChallengeException(403, {
          error: 'sign_in_required',
          description: 'sign in to use this server',
        });
      }
      return asPersonalAgent(actor, principal.scopes);
    },
  };
}
