import type {
  ActorResolver,
  AgentStore,
  ModelProvider,
  QuotaStore,
  Retriever,
  RolesPolicy,
  TokenStreamSink,
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
   * (`AgentRunSteps.llm` / `AgentRunSteps.tool`) instead of in-process `ctx.localStep`s. Requires
   * `durable: true` (module build throws otherwise). Multi-pod fleets MUST wire a cross-process
   * token sink (e.g. a Redis pub/sub `TokenStreamSink`) — the dispatched `llm` step streams from
   * whichever worker serves it, not necessarily the one running this workflow. STATIC top-level flag
   * (like `durable`/`attachments.upload`): it changes what gets registered and how the workflow
   * dispatches, decided at module build time.
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
   * Dispatch the turn's model call and tool executions as routed durable steps. Same static-wiring
   * reasoning as `durable` above — it lives here (not in the async factory result) because it decides
   * how `AgentRunWorkflow` builds its hooks at module build time. Requires `durable: true` (module
   * build throws otherwise). See `AgentModuleOptions.dispatchedSteps` for the full contract.
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
}
