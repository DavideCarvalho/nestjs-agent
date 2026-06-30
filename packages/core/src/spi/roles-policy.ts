import type { Actor, ToolSpec } from '../types.js';

/**
 * Decides whether an actor may invoke a tool. The default impl checks the actor's role
 * against `spec.roles` (defaulting to an ADMIN-only set). Apps can plug `nestjs-authz`
 * or any custom gate here.
 */
export interface RolesPolicy {
  /** May return a promise — an authz Gate (`gate.forUser(actor).allows(...)`) is async. */
  can(actor: Actor, tool: ToolSpec): boolean | Promise<boolean>;
}
