import type { Actor } from '@dudousxd/nestjs-agent-core';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

/**
 * The MCP SDK's `AuthInfo` carrying the acting {@link Actor} the transport authenticated. The HTTP
 * surface attaches one per request, so every `tools/list` / `tools/call` handler reads the identity
 * that request was authenticated as rather than the one the SESSION was opened with.
 */
export interface McpAuthInfo extends Omit<AuthInfo, 'extra'> {
  extra: { actor: Actor };
}

/** Thrown when an MCP request carries no resolvable identity. Never answered with a default actor. */
export class McpUnauthenticatedError extends Error {
  constructor(message = 'unauthorized: no actor is associated with this MCP request') {
    super(message);
    this.name = 'McpUnauthenticatedError';
  }
}

/**
 * Runtime shape check for an {@link Actor}: a non-null object with a NON-EMPTY string `id` and,
 * when present, a `roles` array of strings. An empty id is rejected for the same reason
 * `HeaderActorResolver` rejects an empty `x-actor-id` — it identifies nobody, and everything
 * downstream (quotas, memory scopes, audit rows) would key on the empty string.
 */
export function isActor(value: unknown): value is Actor {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Actor>;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return false;
  if (candidate.roles !== undefined) {
    if (!Array.isArray(candidate.roles)) return false;
    if (!candidate.roles.every((role) => typeof role === 'string')) return false;
  }
  return true;
}

/**
 * Read the acting {@link Actor} off a verified `AuthInfo`, throwing {@link McpUnauthenticatedError}
 * when there is none. This is the last gate before the tool registry: a transport that was wired
 * without authentication reaches it with no `extra.actor` and is refused, rather than being given
 * an invented identity to run tools as.
 */
export function actorFromAuthInfo(authInfo: AuthInfo | undefined): Actor {
  const actor = authInfo?.extra?.actor;
  if (!isActor(actor)) {
    throw new McpUnauthenticatedError();
  }
  return actor;
}
