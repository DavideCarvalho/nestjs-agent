import type { Actor, ActorResolver } from '@dudousxd/nestjs-agent-core';
import { UnauthorizedException } from '@nestjs/common';

/** One issued credential and the identity it acts as. */
export interface McpBearerGrant {
  /** The token the client sends as `Authorization: Bearer <token>`. */
  token: string;
  /**
   * Who that token IS. Its `roles` are what the `RolesPolicy` gates every tool against, so this is
   * where a machine caller's reach is decided — an actor with no roles reaches no tools, which is
   * the right starting point for a new integration.
   */
  actor: Actor;
}

/** Read a string header off an unknown transport request, narrowing without trusting its shape. */
function readHeader(req: unknown, name: string): string | undefined {
  if (typeof req !== 'object' || req === null || !('headers' in req)) return undefined;
  const { headers } = req;
  if (typeof headers !== 'object' || headers === null || !(name in headers)) return undefined;
  const value: unknown = Reflect.get(headers, name);
  return typeof value === 'string' ? value : undefined;
}

/** Constant-time comparison, so a wrong key cannot be refined one character at a time. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

/**
 * An {@link ActorResolver} for machine-to-machine MCP callers: a fixed list of issued tokens, each
 * bound to the actor it acts as.
 *
 * For an integration whose identity the deployment itself decides — a CI job, an internal service,
 * a desktop MCP client you handed a key to. When the caller is a PERSON whose identity your app
 * already knows, pass the resolver you gave `AgentModule` instead, so one user has one set of roles
 * on both surfaces.
 *
 * Rejects with `UnauthorizedException` (401) when the header is absent, malformed, or unknown. It
 * never falls back to an anonymous actor, and it grants no roles of its own — a grant's reach is
 * exactly the roles its `actor` carries.
 */
export class BearerTokenActorResolver implements ActorResolver {
  private readonly grants: readonly McpBearerGrant[];

  constructor(grants: readonly McpBearerGrant[]) {
    // An empty token would be matched by a bare `Authorization: Bearer ` header, which is to say by
    // anyone who knows the endpoint exists.
    const blank = grants.find((grant) => grant.token.length === 0);
    if (blank !== undefined) {
      throw new Error(
        `BearerTokenActorResolver: the grant for actor "${blank.actor.id}" has an empty token. An empty token authenticates every caller.`,
      );
    }
    this.grants = grants;
  }

  resolve(req: unknown): Actor {
    const header = readHeader(req, 'authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const grant =
      token.length === 0
        ? undefined
        : this.grants.find((candidate) => timingSafeEqual(candidate.token, token));
    if (grant === undefined) {
      throw new UnauthorizedException(
        'BearerTokenActorResolver: missing or unknown Authorization: Bearer token.',
      );
    }
    return grant.actor;
  }
}
