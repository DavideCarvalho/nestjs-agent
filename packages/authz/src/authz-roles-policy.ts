import {
  type Actor,
  DefaultRolesPolicy,
  type RolesPolicy,
  type ToolSpec,
} from '@dudousxd/nestjs-agent-core';
import type { Gate } from '@dudousxd/nestjs-authz';

/** Options for {@link AuthzRolesPolicy}. */
export interface AuthzRolesPolicyOptions {
  /**
   * Roles used by the role-based fallback ({@link DefaultRolesPolicy}) when a tool
   * declares neither an `ability` nor `roles`. Defaults to ADMIN-only (the
   * DefaultRolesPolicy default).
   */
  fallbackRoles?: string[];
}

/**
 * The user object handed to `gate.forUser(...)`. The agent {@link Actor} only carries
 * `{ id, roles? }`, which is exactly what authz's default {@link defaultRoleResolver}
 * (and any ad-hoc gate reading `user.roles`) needs to resolve a role-based ability —
 * so no host user entity is required.
 */
export interface AuthzUser {
  id: string;
  roles?: string[];
}

/**
 * Map an agent {@link Actor} onto the minimal user shape authz expects. authz's
 * `User` is `unknown`, and its default role resolver reads `user.roles`; passing
 * `{ id, roles }` is enough for a role-based ability to resolve. `roles` is only
 * attached when present (honors `exactOptionalPropertyTypes`).
 */
export function userFromActor(actor: Actor): AuthzUser {
  return { id: actor.id, ...(actor.roles !== undefined ? { roles: actor.roles } : {}) };
}

/**
 * A {@link RolesPolicy} backed by a `@dudousxd/nestjs-authz` {@link Gate}.
 *
 * - When a tool declares an `ability`, the decision is delegated to the Gate
 *   (`gate.forUser(actor).allows(ability)`), so apps get policies, abilities, and the
 *   RBAC seams for free.
 * - Otherwise it falls back to the role-based {@link DefaultRolesPolicy} (matching the
 *   actor's role against `tool.roles`, defaulting to `fallbackRoles`).
 */
export class AuthzRolesPolicy implements RolesPolicy {
  constructor(
    private readonly gate: Gate,
    private readonly options?: AuthzRolesPolicyOptions,
  ) {}

  async can(actor: Actor, tool: ToolSpec): Promise<boolean> {
    if (tool.ability !== undefined) {
      return this.gate.forUser(userFromActor(actor)).allows(tool.ability);
    }
    return new DefaultRolesPolicy(this.options?.fallbackRoles).can(actor, tool);
  }
}
