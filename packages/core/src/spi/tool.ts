import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { UiCapabilities } from '../genui/capabilities.js';
import type { ComponentPresentation } from '../genui/registry.js';
import type { ToolConfirmation } from '../tool-presentation.js';
import type { Actor, PageContext } from '../types.js';

/**
 * Per-invocation context handed to a tool handler. Host-supplied bits are optional. Identity lives
 * on {@link AiToolCtx.actor} — read `ctx.actor.id` / `ctx.actor.tenantRef` (single source of truth;
 * no denormalized copies).
 */
export interface AiToolCtx {
  /** Reports presentation failures separately from successful domain execution. */
  onPresentationError?(error: unknown, details: { toolName: string }): void | Promise<void>;
  uiCapabilities?: UiCapabilities;
  actor: Actor;
  threadId: string;
  runId: string;
  requestId: string;
  /**
   * The id of the tool call this invocation serves. Absent where a tool is invoked outside a turn
   * (the MCP server, a direct `registry.invoke`).
   */
  toolCallId?: string;
  /**
   * `<runId>:<toolCallId>` — the same value for every execution of THIS call, and for no other.
   *
   * A tool's side effect and the checkpoint that records it are two writes. Under the durable
   * runner a worker that dies between them leaves a call the journal does not know ran, and the
   * runtime's recovery runs it again; an in-step transient retry (a deadlock, a lock-wait timeout)
   * re-invokes it too. The library cannot make your write atomic with its journal — so it hands you
   * the key that makes the second attempt recognisable: pass it to whatever you call as its
   * idempotency key (a payment provider's `Idempotency-Key`, a unique column on the row you insert,
   * a workflow's `id`), and a re-execution lands on the first one's result instead of doing it
   * twice. Stable across replays and across pods: the run id is the run's own, and the call id
   * comes out of the journaled model step.
   *
   * Absent where a tool is invoked outside a turn (the MCP server, a direct `registry.invoke`).
   */
  idempotencyKey?: string;
  /** The name of the agent running this turn — provenance a tool can scope on (e.g. capability sets). */
  agentName?: string;
  /** The persona of {@link agentName} the turn runs under, when it runs under one. */
  persona?: string;
  pageContext?: PageContext;
  /** Optional host handle (e.g. an ORM EntityManager) the app threads through options. */
  host?: unknown;
  /**
   * Aborted when the run this call belongs to is stopped. Pass it to whatever the tool waits on (a
   * `fetch`, a query, a child process) so a Stop does not wait for the tool to finish. Absent where
   * the runner cannot stop a call in flight (the durable runner) and outside a turn.
   */
  abortSignal?: AbortSignal;
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
    options?: EmitUiOptions,
  ): Promise<{ id: string }>;
}

/** When the action state is being checked. */
export interface ToolPreflightOptions {
  phase: 'prepare' | 'execute';
}

export type ToolPreflightResult<O = unknown> =
  | { status: 'ready'; confirmation?: ToolConfirmation }
  | { status: 'denied'; reason: string }
  | { status: 'completed'; output: O };

/** A tool implementation. `I` is the input parsed by its registered Standard Schema. */
export interface ToolHandler<I = unknown, O = unknown> {
  execute(input: I, ctx: AiToolCtx): Promise<O>;
  /** Optional UI derived from successful domain output; errors never fail the domain action. */
  present?(
    output: O,
    ctx: AiToolCtx,
  ):
    | ComponentPresentation<object>
    | readonly ComponentPresentation<object>[]
    | undefined
    | Promise<ComponentPresentation<object> | readonly ComponentPresentation<object>[] | undefined>;
  /** Read-only action check. Runs after authorization and validation, before approval and again
   * immediately before execution. Confirmation strings are resolved, never templates. */
  preflight?(
    input: I,
    ctx: AiToolCtx,
    options: ToolPreflightOptions,
  ): ToolPreflightResult<O> | Promise<ToolPreflightResult<O>>;
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
   * It shapes what the model is SHOWN: the registry still validates a call against the
   * registered `inputSchema`, so a tool whose accepted input varies per turn registers a permissive
   * schema and validates in `execute`. The one exception is `available: false`, which is also asked
   * again on invoke (with the call's actor, thread, agent and `uiCapabilities`): a call to a tool
   * that answers it is refused as an unknown tool, so the model cannot run what it was not offered.
   */
  describe?(
    scope: ToolDescribeScope,
  ): ToolDescription | undefined | Promise<ToolDescription | undefined>;
  /**
   * Show something while the model is still WRITING this tool's input: called when a streamed call
   * starts (`tool-input-start`), it answers how to preview the arguments so far — or `undefined` for
   * no preview. The loop parses the streamed argument text as it arrives and pushes what
   * {@link ToolInputPreview.render} answers as a `ui` frame with `partial: true`, throttled, under
   * the id the call's first `ctx.emitUi` push gets (`<toolCallId>:ui:0`) — so that push replaces it
   * in place. A preview the call never replaces (it failed, or degraded to text) is withdrawn.
   *
   * A preview is shown, never trusted: it is not validated, not persisted, not handed to text
   * channels, and nothing about it reaches the model.
   */
  previewInput?(
    scope: ToolInputPreviewScope,
  ): ToolInputPreview | undefined | Promise<ToolInputPreview | undefined>;
}

/** Whose call {@link ToolHandler.previewInput} previews. */
export interface ToolInputPreviewScope extends ToolDescribeScope {
  toolCallId: string;
}

/** The arguments of a streamed call so far, read with `parsePartialJson`. */
export interface PartialToolInput {
  /** What has been parsed so far (open objects and arrays hold what they have). */
  value: unknown;
  /** The model finished the arguments: `value` is the whole input (still unvalidated). */
  done: boolean;
  /** Is this object or array (one of `value`'s) still being written? */
  isOpen(container: object): boolean;
  /** The member of `container` whose value is cut off mid-way (a string half written). */
  pendingMember(container: object): string | number | undefined;
}

/** A partial `ui` frame a preview pushes. */
export interface ToolInputPreviewFrame {
  component: string;
  props: Record<string, unknown>;
  version?: number;
}

/** How one streamed call is previewed ({@link ToolHandler.previewInput}). */
export interface ToolInputPreview {
  /**
   * The frame for the input so far. `undefined`: nothing new to show (what was shown stays).
   * `null`: stop previewing this call, and withdraw what was shown — the final push will not
   * replace it (the input can no longer turn out valid, or will degrade to text).
   */
  render(input: PartialToolInput): ToolInputPreviewFrame | null | undefined;
  /** Least time between two preview frames of one call, in ms. Default 100. */
  throttleMs?: number;
}

/** Who a turn's tool list is being built for — what {@link ToolHandler.describe} can vary on. */
export interface ToolDescribeScope {
  uiCapabilities?: UiCapabilities;
  actor: Actor;
  /** Absent where the list is built outside a conversation (the MCP server's `tools/list`). */
  threadId?: string;
  agentName?: string;
}

/** A per-turn override of a tool's model-facing definition ({@link ToolHandler.describe}). */
export interface ToolDescription {
  /** False removes this tool from the current model-facing catalog. */
  available?: boolean;
  description?: string;
  inputSchema?: StandardSchemaV1;
}

/** Metadata recorded with a pushed UI component. */
export interface EmitUiOptions {
  id?: string;
  version?: number;
  fallbackText?: string;
  componentVersions?: Record<string, number>;
}
