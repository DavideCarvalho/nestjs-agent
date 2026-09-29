import type { StandardSchemaV1 } from '@standard-schema/spec';
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
  /**
   * Push a component into the assistant message: streamed live as a `ui` frame and persisted on
   * the message, so a reload shows it where the live stream did. Resolves to the component's id.
   *
   * `id` defaults to `<toolCallId>:ui:<n>` (the n-th push without an `id` in this invocation), so a retried or
   * re-executed call REPLACES what it pushed before instead of adding a second copy; pass your own
   * `id` to update one component across pushes (streaming rows into a table). `props` must be
   * JSON; it is snapshotted when pushed.
   *
   * Replay-safe under the durable runner: the pushed components ride the tool step's journaled
   * result, so a replay neither streams nor persists them again.
   *
   * Always present. On a surface with no conversation to push into (the MCP server, a direct
   * `registry.invoke` without one) it is a no-op that still resolves to an id, so a tool calls
   * `ctx.emitUi(…)` unconditionally.
   */
  emitUi(
    component: string,
    props: Record<string, unknown>,
    options?: { id?: string; version?: number },
  ): Promise<{ id: string }>;
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
  /**
   * What the model is told about this tool for THIS turn — a description and/or input schema that
   * depend on who is asking (a per-tenant component catalog, a per-plan list of options). Called
   * when the turn's tool list is built, after every gate has passed; whatever it returns replaces
   * the registered spec's `description` / `inputSchema` in the definition the model sees. Omit, or
   * return `undefined`, to use the registered spec as is.
   *
   * It shapes what the model is SHOWN only: the registry still validates a call against the
   * registered `inputSchema`, so a tool whose accepted input varies per turn registers a permissive
   * schema and validates in `execute`.
   */
  describe?(
    scope: ToolDescribeScope,
  ): ToolDescription | undefined | Promise<ToolDescription | undefined>;
}

/** Who a turn's tool list is being built for — what {@link ToolHandler.describe} can vary on. */
export interface ToolDescribeScope {
  actor: Actor;
  /** Absent where the list is built outside a conversation (the MCP server's `tools/list`). */
  threadId?: string;
  agentName?: string;
}

/** A per-turn override of a tool's model-facing definition ({@link ToolHandler.describe}). */
export interface ToolDescription {
  description?: string;
  inputSchema?: StandardSchemaV1;
}
