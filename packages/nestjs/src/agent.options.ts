import type {
  ActorResolver,
  AgentHistoryWindow,
  AgentStore,
  HistoryPolicy,
  InputProcessor,
  MemoryProvider,
  ModelProvider,
  OutputProcessor,
  QuotaStore,
  Retriever,
  RolesPolicy,
  ScopeResolver,
  SkillProvider,
  TokenStreamSink,
  ToolTransientRetrySetting,
} from '@dudousxd/nestjs-agent-core';
import type {
  CanActivate,
  InjectionToken,
  ModuleMetadata,
  OptionalFactoryDependency,
  Type,
} from '@nestjs/common';
import type { FunctionalTool } from './functional-tool.js';

/**
 * Which half of the module this process mounts — the split that lets an API pod and a WORKER pod
 * each load `AgentModule` without either one doing the other's job:
 *
 * - `'both'` (default): today's behavior, unconditionally — every controller AND the full durable
 *   engine wiring (when `durable: true`). Zero-config single-pod deployments never touch this.
 * - `'http'`: mounts every controller (chat/threads/tool-call/quota/agents/attachments) so the HTTP
 *   surface is fully functional, but under `durable: true` this pod must never EXECUTE agent work —
 *   see `AgentDurableModuleOptions.surface` (`@dudousxd/nestjs-agent/durable`), which is where the
 *   actual step-handler exclusion happens; this flag only controls the controllers here.
 * - `'engine'`: mounts NO controllers (an API pod's routes have no business existing on a worker
 *   pod that never receives HTTP traffic) — everything else (registry/tools/model/store/sinks, the
 *   `agent.run` workflow, and its dispatched steps under `AgentDurableModule`) stays wired exactly
 *   as `'both'`.
 *
 * A durable deployment mirrors this on `AgentDurableModule.forRoot({ surface })` too — see that
 * module's doc for why the split can't be inferred from this option alone (Nest's static module
 * metadata can't be computed from a runtime-injected value).
 */
export type AgentSurface = 'http' | 'engine' | 'both';

/**
 * `AgentModuleOptions.attachments` — bounds and content-type allowlist for the optional
 * `POST /agent/attachments` upload controller (see `attachments.upload`).
 */
export interface AgentAttachmentsOptions {
  /** Per-file size cap. Defaults to 20 MiB. */
  maxBytes?: number;
  /**
   * Allowed multipart content types. Defaults to what multimodal model providers commonly accept:
   * `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `application/pdf`, `text/plain`, `text/csv`.
   */
  allowedContentTypes?: string[];
  /**
   * Mount `POST /agent/attachments`. Defaults to `false` — the controller is build-time (static)
   * wiring, so this can't be inferred from whether `AGENT_ATTACHMENT_STAGING` ends up bound (that's
   * a DI-time fact); set it explicitly. `true` with no `AGENT_ATTACHMENT_STAGING` provider bound
   * fails boot loudly instead of silently mounting a controller that 501s on every request.
   */
  upload?: boolean;
}

/**
 * `AgentModuleOptions.skills` — where a turn's skills come from, and which scopes an actor draws
 * them from. Its PRESENCE turns skills on: `skills: {}` offers whatever the `@Skill`-decorated
 * providers declare, resolved against the actor's own, their tenant's and the deployment's scopes.
 */
export interface AgentSkillsOptions {
  /**
   * A provider of your own — skills a host stores and administers itself (per user, per sector, per
   * base). Merged with the discovered `@Skill` classes, and outranking them for a name published at
   * the same scope. Omit → the decorated classes are the whole catalog.
   */
  provider?: SkillProvider;
  /**
   * Which scope tokens an actor draws from, most specific first — the precedence order. Omit → the
   * actor's own (`actor:<id>`), their tenant's (`tenant:<ref>`, when they have one), and `global`.
   * Supply one to add an axis this library has no key for: a sector, a squadron, a shift.
   */
  scopes?: ScopeResolver;
  /**
   * How many skills the catalog block offers before it starts leaving the widest ones out. Omit →
   * 20. A ceiling on what the SYSTEM PROMPT carries, not on how many a deployment may hold.
   */
  maxSkills?: number;
}

/**
 * `AgentModuleOptions.memory` — where what the assistant concluded about a person is stored, and how
 * much of it a turn may carry. Its PRESENCE turns memory on.
 *
 * Unlike `skills`, there is no decorator and no zero-config form: a memory is by definition something
 * the agent worked out about someone, so a memory a developer wrote in a class would be an
 * instruction wearing a memory's clothes — which is what `@Skill` and `@SystemPromptContributor()`
 * are for. The rows are the host's from the start.
 */
export interface AgentMemoryOptions {
  /**
   * Where the rows live. `forget` is required on it; `write` is what decides the `remember` tool;
   * `search` is what decides whether a turn's block is selected by relevance or read whole. Supply
   * `search` once the applicable set outgrows `maxMemories` — without it the ceiling selects by
   * scope, and the widest scopes are the ones it starves.
   */
  provider: MemoryProvider;
  /**
   * Which scope tokens an actor draws from, most specific first — the precedence order, and the same
   * seam `skills` uses. Omit → the actor's own, their tenant's, and `global`.
   */
  scopes?: ScopeResolver;
  /**
   * How many memories the block carries. Omit → 20. A budget on the PROMPT, never on the store: with
   * a provider that can `search`, this is how many matter right now rather than how many a person
   * may have. Always-on (`pinned`) memories are taken from it first.
   */
  maxMemories?: number;
  /** How long one memory may be, checked when it is written. Omit → 240. */
  maxFactChars?: number;
}

export interface AgentModuleOptions {
  // --- infrastructure ---
  /** The LLM provider (e.g. a Vercel AI SDK wrapper). Required. */
  model: ModelProvider;
  /**
   * Persistence adapter. Optional — omit it and import a store module (e.g.
   * `MikroOrmAgentStoreModule.forFeature()`) that binds `AGENT_STORE` globally instead. When
   * provided here it takes precedence within this module's scope.
   */
  store?: AgentStore;
  /** Live token transport. Defaults to a single-process in-memory sink. */
  sink?: TokenStreamSink;
  /**
   * A {@link QuotaStore} for the daily token budget. Optional — omit (and omit `quotaLimitTokens`)
   * to disable quotas. Provide this to plug a custom budget; for the common case use the simpler
   * `quotaLimitTokens` instead, which binds the built-in ledger-backed store.
   */
  quota?: QuotaStore;
  /**
   * Daily per-actor token budget, enforced against the persisted usage ledger by the built-in
   * `LedgerQuotaStore`. A convenience over wiring a {@link QuotaStore} by hand — set this and quotas
   * turn on with no extra store. Ignored when an explicit `quota` is provided. Omit to disable.
   */
  quotaLimitTokens?: number;
  /** Tool authorization gate. Defaults to role-in-`defaultRoles`. */
  rolesPolicy?: RolesPolicy;
  /** Default roles a tool requires when its `roles` is omitted. Defaults to `['ADMIN']`. */
  defaultRoles?: string[];
  /**
   * Resolves the acting actor for each request (the identity seam). Required — the agent NEVER
   * fabricates a caller, so this is a compile-time obligation, not an optional with a throwing
   * placeholder. Read your authenticated principal here (session / JWT / `nestjs-context`), or use
   * the opt-in `HeaderActorResolver` for demos and header-trusting gateways.
   */
  actorResolver: ActorResolver;
  /** Route prefix the controllers mount under. Defaults to `'agent'` (→ `/agent/chat`, …). */
  path?: string;
  /**
   * Run each turn as a durable workflow instead of in-process. Requires importing
   * `AgentDurableModule` from `@dudousxd/nestjs-agent/durable` and a configured `DurableModule`.
   */
  durable?: boolean;
  /**
   * Dispatch the turn's model call and tool executions as routed durable steps
   * (`AgentRunSteps.llm` / `AgentRunSteps.tool`) instead of in-process `ctx.localStep`s. OMITTED
   * keeps them in-process; `true` without `durable: true` throws at module build.
   *
   * WHAT IT BUYS: the run is not pinned to one pod for the two long parts of a turn, so a fleet can
   * scale the model call and tool execution separately from the workflow itself.
   *
   * WHY IT IS NOT A DEFAULT. It relocates the HOST's own code. A tool handler no longer runs inside
   * the turn's workflow body but inside whichever worker serves the routed group, and the `llm`
   * step re-runs the host's tool-visibility callbacks there to rebuild its tool list. A handler
   * that resolves anything per invocation from its caller's execution context — a request-scoped
   * ORM EntityManager, an AsyncLocalStorage tenant, a CLS transaction — finds nothing in that
   * worker, and the library has no way to know which handlers do that. Turn this on once the tools
   * this deployment registers establish whatever context they need themselves.
   *
   * The cross-process-sink requirement is a property of `durable: true` itself, not of this flag:
   * the turn already runs on whichever worker takes `agent.run`, which may not be the pod holding
   * the SSE connection — multi-pod fleets MUST wire a cross-process token sink (e.g. a Redis
   * pub/sub `TokenStreamSink`) either way. STATIC top-level flag (like `durable`/
   * `attachments.upload`): it decides how the workflow dispatches at module build time.
   */
  dispatchedSteps?: boolean;
  /**
   * Static functional tools (`{ spec, handler }`, e.g. from `createExecuteSqlTool`) to register at
   * boot. For tools that need DI-resolved dependencies, use `provideAgentTool(factory, inject)` in a
   * module's `providers` instead.
   */
  tools?: FunctionalTool[];
  /**
   * Per-tool execution timeout in ms. A tool that runs longer is aborted and recorded as failed (the
   * model receives the timeout as its result and can adapt) instead of hanging the turn. Omit → none.
   */
  toolTimeoutMs?: number;
  /**
   * Retries a tool's own invocation, in place, when it throws a classified-transient error (a DB
   * deadlock, a lock-wait timeout, a serialization failure) — never a new durable checkpoint, just
   * repeated attempts inside the same tool-call step. Default ON: `{ attempts: 2, backoffMs: 150 }`
   * with the default classifier. Set `{ classify }` to widen/narrow which errors count as transient
   * (checked in BOTH the inline and durable-dispatched execution paths via DI, since the classify
   * function itself can't ride a durable step's wire envelope), or `false` to disable entirely. A
   * tool's other (non-transient) failures are unaffected — they remain a one-shot business outcome.
   */
  toolTransientRetry?: ToolTransientRetrySetting;
  /**
   * Suggest follow-up questions after the final turn. `true` → 3 suggestions; `{ count }` → that many.
   * Costs one extra model call per turn (recorded as `follow_ups` usage), stored on the assistant
   * message's `followUps`. Omit/`false` → disabled.
   */
  followUps?: boolean | { count: number };
  /**
   * Always-on ("inject") RAG: before each turn, retrieve passages for the user message and augment
   * the system prompt with them. For agentic retrieval (the model decides when to search) DON'T set
   * this — instead expose the tool: `provideAgentTool(createRetrievalTool(retriever))`. Omit → off.
   */
  retrieval?: { mode: 'inject'; retriever: Retriever; topK?: number };

  /**
   * Bounds how much of a thread rides into each turn. Omit and a turn carries EVERY message the
   * thread holds, so a long-lived thread costs more each time and eventually exceeds the model's
   * context limit outright. `{ maxMessages }` and/or `{ maxTokens }` keep the newest that fit;
   * `{ summarize: true }` folds what they left out into a leading summary, at the price of one extra
   * model call per run (recorded as `history_summary` usage). An agent can override this for itself
   * with `@Agent({ history })`.
   */
  history?: AgentHistoryWindow;
  /**
   * A {@link HistoryPolicy} of your own — for a window the built-in can't express (pinning the
   * thread's opening brief, keeping every message that carries a tool result, a budget that varies
   * by actor). A convenience-vs-custom pair like `quotaLimitTokens`/`quota`: this outranks a
   * module-wide `history`, and `@Agent({ history })` outranks both for the agent that declares it.
   * `select` MUST be pure — see the SPI's determinism contract.
   */
  historyPolicy?: HistoryPolicy;

  /**
   * Rewrites the prompt before every model call — masking identifiers, stamping a policy preamble,
   * trimming an oversized tool result. Applies to EVERY agent: a transformation one persona can opt
   * out of is not a control. Transformation only; `history`/`historyPolicy` still own which messages
   * are there to transform. A processor needing DI-resolved dependencies is built in
   * `forRootAsync`'s `useFactory` (which has `inject`), the same way `retrieval.retriever` is.
   */
  inputProcessors?: InputProcessor[];
  /**
   * Gates every model answer before the stream, the store or the next step sees it — redact,
   * replace, or refuse the turn outright (which fails it with an `output_rejected` stream error).
   *
   * REGISTERING ONE TURNS OFF LIVE TOKEN STREAMING. Reading the whole answer and streaming it as it
   * is generated cannot both be true, so the turn's model output is buffered and released in one
   * frame once the chain passes. That is the price of a gate that actually gates; see
   * `AgentLoopDeps.outputProcessors` for exactly what a subscriber still receives live.
   */
  outputProcessors?: OutputProcessor[];

  /**
   * Offer every agent the built-in `ask` tool, so the model can put its own clarifying question set
   * to the user when it judges the scope is missing. The turn parks on the answers exactly as it
   * parks on a HITL approval, and they arrive through `POST /agent/tool-call/answer`.
   *
   * `ask` is not a registered tool and has no handler — the loop settles it against a person — so no
   * `RolesPolicy` gates it: asking a question performs nothing. An `@Agent({ ask })` overrides this
   * for one persona. Omit → the model never sees it, and nothing about a turn changes.
   */
  ask?: boolean;

  /**
   * Authored procedures any agent may pull in when a task calls for one — per-user, per-tenant or
   * deployment-wide, with the most specific winning. Declared as `@Skill`-decorated providers and/or
   * served by a `provider` of your own; offered to the model as a one-line-each catalog it loads
   * from on demand, so an instruction costs a prompt only on the turns that need it.
   *
   * Omit → no catalog, no `skill` tool, and a turn's checkpoint sequence is byte-identical to one
   * that never had the option. See {@link AgentSkillsOptions}.
   */
  skills?: AgentSkillsOptions;

  /**
   * What the assistant has concluded about the actor and their organisation, carried into every turn
   * as a bounded block of one-line facts and written by the model through a built-in `remember` tool.
   *
   * NOT the same thing as retrieval, and not a second name for it: `retrieval` answers from documents
   * a person curated and can fix at the source, memory answers from the agent's own inferences about
   * someone who never saw them written. That is why the rows carry an origin, why the block tells the
   * model they may be wrong, and why `GET /agent/memories` + `DELETE /agent/memories/:id` are part of
   * the feature rather than an optional console.
   *
   * Omit → no block, no `remember` tool, and a turn's checkpoint sequence is byte-identical to one
   * that never had the option. See {@link AgentMemoryOptions}.
   */
  memory?: AgentMemoryOptions;

  /**
   * The name of the agent a turn uses when the caller doesn't select one. Omit → the single
   * discovered `@Agent` (when there is exactly one), else `'default'` (a bare assistant if no
   * `@Agent` is registered). Agents themselves are declared as `@Agent`-decorated providers, not here.
   */
  defaultAgent?: string;

  /**
   * Guard(s) applied uniformly to EVERY controller this module mounts (chat, threads, tool-call,
   * quota, agents, and — when `attachments.upload` is set — attachments). Third-party controller
   * classes can't be annotated with `@UseGuards` by consumers, so without this option every route is
   * open beyond whatever `actorResolver` itself enforces. Guard classes are added to this module's
   * `providers` so Nest can DI-instantiate them; if a guard has its own dependencies, make sure they
   * resolve from this module's imports or a global module.
   */
  guards?: Type<CanActivate>[];

  /** Bounds/allowlist for the optional attachment-upload controller. Omit → 20 MiB, the documented default types, not mounted. */
  attachments?: AgentAttachmentsOptions;

  /**
   * Which half of the module this process mounts (see {@link AgentSurface}). Omit → `'both'`,
   * today's behavior with zero change. STATIC top-level field (like `durable`/`path`) — it decides
   * which controllers exist at module-build time, not something a request can flip.
   */
  surface?: AgentSurface;
}

export interface AgentModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useFactory: (...args: never[]) => AgentModuleOptions | Promise<AgentModuleOptions>;
  /**
   * Route prefix the controllers mount under (default `'agent'`). Static routing metadata, so it
   * lives here rather than in the async factory result (which resolves too late to mount routes).
   */
  path?: string;
  /**
   * Run each turn as a durable workflow. Static wiring metadata (which `AGENT_RUNNER` to bind), so
   * it lives here rather than in the async factory result — the factory resolves too late to swap
   * the runner. Requires importing `AgentDurableModule` and a configured `DurableModule`.
   */
  durable?: boolean;
  /**
   * Dispatch the turn's model call and tool executions as routed durable steps. Omitted keeps the
   * turn's steps in-process localSteps. Same static-wiring reasoning as `durable` above — it lives
   * here (not in the async factory result) because it decides how `AgentRunWorkflow` builds its
   * hooks at module build time. `true` without `durable: true` throws at module build. See
   * `AgentModuleOptions.dispatchedSteps` for the full contract.
   */
  dispatchedSteps?: boolean;
  /**
   * Set when `AGENT_STORE` is bound by a globally-imported store module (e.g.
   * `MikroOrmAgentStoreModule.forFeature()`) instead of returned as `store` from `useFactory`.
   *
   * `forRoot` decides this synchronously (`store` present or not), but the async factory resolves
   * too late to inspect — so by default `forRootAsync` binds `AGENT_STORE` from the factory result,
   * which would shadow a global store binding with `undefined` when the factory omits `store`. Set
   * this to `true` to skip the local binding and defer to the global one. Leave it unset (and return
   * `store` from the factory) when the store is constructed inside the factory.
   */
  externalStore?: boolean;

  /**
   * Guard(s) applied uniformly to every controller this module mounts. A STATIC field on the async
   * config object itself — NOT part of what `useFactory` resolves — because controllers (and the
   * enhancers bound to them) are wired at module build time, before any async factory has run. If a
   * guard needs async-resolved config (e.g. a secret from a `ConfigService`), have the guard inject
   * that service via DI (see `imports`/`inject` above) rather than trying to thread it through
   * `useFactory`. Same default-open caveat as `AgentModuleOptions.guards`.
   */
  guards?: Type<CanActivate>[];

  /**
   * Mount `POST /agent/attachments`. Static, build-time control (same reasoning as `durable`/`path`
   * above) — `useFactory` resolves too late to decide which controllers exist. The resolved
   * `AgentModuleOptions.attachments` (maxBytes/allowedContentTypes) still applies at request time;
   * only the yes/no mount decision has to live here.
   */
  attachmentsUpload?: boolean;

  /**
   * Which half of the module this process mounts (see {@link AgentSurface}). Same static-wiring
   * reasoning as `attachmentsUpload`/`durable` above — `useFactory` resolves too late to decide
   * which controllers exist. Omit → `'both'`, today's behavior with zero change.
   */
  surface?: AgentSurface;
}
