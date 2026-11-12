import type { Actor } from '../types.js';

/**
 * Resolves the acting {@link Actor} for an inbound request. This is the identity seam:
 * the agent NEVER fabricates a caller. Configure one via `AgentModule.forRoot({ actorResolver })`
 * that reads your authenticated principal (session, JWT, `@dudousxd/nestjs-context`, ...).
 *
 * When no resolver is configured, the module installs `AnonymousActorResolver`: the endpoints are
 * public and every browser is its own anonymous actor (an `HttpOnly` cookie), with a boot notice.
 * Require login with `requestUserActorResolver()` (reads `req.user`) or a resolver of your own. See
 * `HeaderActorResolver` for a header-based resolver suitable for demos and gateways that strip/re-set
 * the headers.
 *
 * `req` is the transport request object. Defaults to `unknown` to keep core framework-agnostic
 * (a NestJS/Express app receives the express `Request`) — a host may narrow it via
 * `ActorResolver<Request>` instead of writing its own `unknown`-narrowing type guard.
 */
export interface ActorResolver<TReq = unknown> {
  resolve(req: TReq): Actor | Promise<Actor>;
}
