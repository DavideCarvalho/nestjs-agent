import type { Actor } from '../types.js';

/**
 * Resolves the acting {@link Actor} for an inbound request. This is the identity seam:
 * the agent NEVER fabricates a caller. Configure one via `AgentModule.forRoot({ actorResolver })`
 * that reads your authenticated principal (session, JWT, `@dudousxd/nestjs-context`, ...).
 *
 * When no resolver is configured, the module installs one that throws on every request —
 * an identity is never invented from a default. See `HeaderActorResolver` for a header-based
 * resolver suitable for demos and gateways that strip/re-set the headers.
 *
 * `req` is the transport request object, typed `unknown` to keep core framework-agnostic;
 * a NestJS/Express app receives the express `Request`.
 */
export interface ActorResolver {
  resolve(req: unknown): Actor | Promise<Actor>;
}
