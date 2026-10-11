import { type ScopeResolver, defaultScopeResolver } from './skills.js';
import type { RolesPolicy } from './spi/roles-policy.js';
import { DEFAULT_ROLES_OF, defaultRolesOf } from './tool-registry.js';
import type { Actor, ToolSpec } from './types.js';

/**
 * The role every personal agent carries — a caller acting for a person from OUTSIDE this app (a
 * Personal Agent Protocol "Poppy" conversation, a Poppy session's MCP token). What a tool names in
 * its `roles` to be reachable by personal agents at all.
 */
export const PERSONAL_AGENT_ROLE = 'personal_agent';

/** The role a granted scope becomes. Namespaced, so a scope can never pose as an app role. */
export const SCOPE_ROLE_PREFIX = 'scope:';

/** `scope:<id>` — the role a personal agent carries for each scope its user granted. */
export function scopeRole(scope: string): string {
  return `${SCOPE_ROLE_PREFIX}${scope}`;
}

/** Whether `actor` is a personal agent ({@link PERSONAL_AGENT_ROLE}). */
export function isPersonalAgent(actor: Actor): boolean {
  return (actor.roles ?? []).includes(PERSONAL_AGENT_ROLE);
}

/**
 * Wrap a {@link RolesPolicy} so personal agents reach only what was written for them.
 *
 * A personal agent carries {@link PERSONAL_AGENT_ROLE}, plus one {@link scopeRole} per granted
 * scope. For it, a tool must DECLARE one of those roles, and the wrapped policy must agree too. A
 * tool with no `roles` is unreachable: under the default policy "no roles" means "anyone", and an
 * app's existing tools were never written with an outside caller in mind. Every other actor is
 * decided by the wrapped policy alone, unchanged — so `AgentModule` wraps its policy in this
 * always, and the MCP server does too.
 *
 * @experimental Part of the Personal Agent Protocol (Poppy, Draft 0.1) support.
 */
export function personalAgentGate(inner: RolesPolicy): RolesPolicy {
  if ((inner as { [GATED]?: true })[GATED] === true) return inner;
  const defaults = defaultRolesOf(inner);
  return {
    [GATED]: true,
    // Kept readable through the gate: `closeEmptyRoles` falls back on them for undeclared roles.
    ...(defaults !== undefined ? { [DEFAULT_ROLES_OF]: defaults } : {}),
    async can(actor: Actor, tool: ToolSpec) {
      if (isPersonalAgent(actor)) {
        const roles = actor.roles ?? [];
        if (!(tool.roles ?? []).some((role) => roles.includes(role))) return false;
      }
      return inner.can(actor, tool);
    },
    /**
     * A personal agent is OFFERED every tool written for personal agents — `personal_agent`, or a
     * `scope:` role even when that scope was not granted. Running it still needs {@link can}; the
     * denied call is what a Poppy turn turns into an `authorization` event (step-up), so the model
     * asks for a permission by doing what it would do anyway.
     */
    async canOffer(actor: Actor, tool: ToolSpec) {
      if (!isPersonalAgent(actor)) {
        return inner.canOffer ? inner.canOffer(actor, tool) : inner.can(actor, tool);
      }
      return (tool.roles ?? []).some(
        (role) => role === PERSONAL_AGENT_ROLE || role.startsWith(SCOPE_ROLE_PREFIX),
      );
    },
  } as RolesPolicy;
}

/** Marks a policy already wrapped by {@link personalAgentGate}, so wrapping twice is a no-op. */
const GATED = Symbol.for('@dudousxd/nestjs-agent:personal-agent-gate');

/**
 * Wrap the {@link ScopeResolver} of memory or skills so a personal agent resolves NO scope. Its
 * actor id may be the account's — without this it would read the account's memories (and its
 * tenant's) and could write new ones, a standing instruction to the user's own assistant.
 *
 * @experimental Part of the Personal Agent Protocol (Poppy, Draft 0.1) support.
 */
export function personalAgentScopes(inner: ScopeResolver | undefined): ScopeResolver {
  const resolver = inner ?? defaultScopeResolver;
  return {
    resolve: (ctx) => (isPersonalAgent(ctx.actor) ? [] : resolver.resolve(ctx)),
  };
}

/**
 * The scopes a personal agent lacks to RUN a tool it is offered ({@link personalAgentGate}: a tool
 * behind a `scope:` role is offered to every personal agent, run only with that scope). `null` when
 * the actor is not a personal agent, the tool is not offered to it, or it may run it.
 */
export async function missingScopes(
  actor: Actor,
  spec: ToolSpec,
  policy: RolesPolicy,
): Promise<string[] | null> {
  const roles = actor.roles ?? [];
  if (!roles.includes(PERSONAL_AGENT_ROLE)) return null;
  const offered = policy.canOffer ? await policy.canOffer(actor, spec) : true;
  if (!offered || (await policy.can(actor, spec))) return null;
  const missing = (spec.roles ?? [])
    .filter((role) => role.startsWith(SCOPE_ROLE_PREFIX) && !roles.includes(role))
    .map((role) => role.slice(SCOPE_ROLE_PREFIX.length));
  return missing.length > 0 ? missing : null;
}
