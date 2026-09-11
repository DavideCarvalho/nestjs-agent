import type { Actor, ActorResolver } from '@dudousxd/nestjs-agent-core';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import { isActor } from './mcp-actor.js';

/**
 * Resolve the acting actor for one MCP request, or reject it.
 *
 * Every rejection is a 401, never a 500: an unidentified caller is a normal event on a public
 * endpoint, and a plain `Error` escaping a resolver would reach the client as "Internal server
 * error" with a logged stack — misreporting the request and turning anonymous probes into error
 * noise. A resolver that already speaks in HTTP terms (`UnauthorizedException`, or a deliberate
 * `ForbiddenException`) is passed through with the status it chose.
 *
 * A resolver that answers with something that is not an {@link Actor} — no id, an empty id, roles
 * that are not strings — is treated as having failed to identify the caller. The alternative is a
 * malformed identity reaching the roles policy, which would then be asked whether an actor with no
 * id may run a tool.
 */
export async function authenticateMcpRequest(input: {
  auth: ActorResolver;
  request: unknown;
}): Promise<Actor> {
  let resolved: unknown;
  try {
    resolved = await input.auth.resolve(input.request);
  } catch (error) {
    if (error instanceof HttpException) {
      throw error;
    }
    throw new UnauthorizedException(error instanceof Error ? error.message : 'unauthorized');
  }
  if (!isActor(resolved)) {
    throw new UnauthorizedException(
      'The configured MCP actor resolver did not return an actor with an id. No identity is invented for an unauthenticated MCP caller.',
    );
  }
  return resolved;
}
