import type { Actor, PageContext } from '../types.js';

/**
 * Per-invocation context handed to a tool handler. Host-supplied bits are optional. Identity lives
 * on {@link AiToolCtx.actor} — read `ctx.actor.id` / `ctx.actor.tenantRef` (single source of truth;
 * no denormalized copies).
 */
export interface AiToolCtx {
  actor: Actor;
  threadId: string;
  runId: string;
  requestId: string;
  /** The name of the agent running this turn — provenance a tool can scope on (e.g. capability sets). */
  agentName?: string;
  pageContext?: PageContext;
  /** Optional host handle (e.g. an ORM EntityManager) the app threads through options. */
  host?: unknown;
}

/** A tool implementation. `I` is the parsed (Zod-validated) input. */
export interface ToolHandler<I = unknown> {
  execute(input: I, ctx: AiToolCtx): Promise<unknown>;
  /**
   * Whether this tool exists in this deployment at all — evaluated per turn, BEFORE the roles
   * policy, so a `false` here means the model is never shown the tool rather than being shown one
   * it will be refused. Omit → always enabled.
   *
   * This is the seam for a feature flag or a licensing tier: the handler is an ordinary provider,
   * so it can read injected config (`this.config.featureX`) that a decorator, evaluated at import
   * time, cannot. Answering "does this capability exist here?"; `roles`/`RolesPolicy` answers the
   * separate question "may THIS actor use it?", and both still run.
   *
   * Prefer this over conditionally registering the provider: registration happens while the
   * `@Module` metadata is built, which in most apps is before configuration is loaded.
   */
  isEnabled?(): boolean | Promise<boolean>;
  /**
   * Whether THIS actor may use the tool, decided per turn. Omit → the role gate alone decides.
   *
   * The three existing gates all answer the question somewhere else: `roles` is static data,
   * `RolesPolicy` is one app-wide rule for every tool, and an agent's `tools` allow-list is fixed
   * when the agent is declared. This one lives on the tool and runs with DI, so it can ask the
   * questions only the tool knows to ask — is this user's org on the plan that includes it, does
   * this actor own the base being queried, is the per-user override in the DB set today.
   *
   * Runs AFTER {@link isEnabled} and the `RolesPolicy`, and all of them must pass. Applied both
   * when the turn's tool list is built (a denied actor is never shown it) and again on invoke.
   */
  canUse?(actor: Actor): boolean | Promise<boolean>;
}
