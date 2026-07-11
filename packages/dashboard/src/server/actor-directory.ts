/**
 * Resolves `actorRef`s (the opaque ids the store persists — `user:123`, `tenant:acme`) to a
 * human-readable display label for the console (a name, an email, a tenant's display name). A host
 * implements this against its own identity store; the dashboard never invents a label.
 *
 * Re-exported from `@dudousxd/nestjs-agent-core` (a pure type, so — unlike the `AGENT_ACTOR_DIRECTORY`
 * token in `./tokens.js`, which is redeclared BY VALUE for ESM/CJS dual-instance safety — importing
 * it directly here carries no runtime identity risk).
 */
export type { ActorDirectory } from '@dudousxd/nestjs-agent-core';
