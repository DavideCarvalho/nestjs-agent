import type {
  ActionApprovalMode,
  ActionProposal,
  BackgroundActorResolver,
  TextActionProposalConfig,
} from '@dudousxd/nestjs-agent-core';
import type {
  ActorResolver,
  AgentHistoryWindow,
  AgentStore,
  ApprovalPolicy,
  EmptyRoles,
  HistoryPolicy,
  InputProcessor,
  MemoryProvider,
  ModelCatalog,
  ModelProvider,
  OutputProcessor,
  PromptBuilder,
  QuotaProvider,
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
import type { AgentEngine } from './engine.js';
import type { FunctionalTool } from './functional-tool.js';
import type { QuotaLimits } from './ledger-quota-provider.js';
import type { AgentProtocolAdapter } from './protocol-adapter.js';

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
 * `AgentModuleOptions.attachments` — limits for `POST <base>/attachments`, when the bound
 * `AGENT_ATTACHMENT_STAGING` store does not declare its own (`AgentMediaAttachmentsModule` does, and
 * then it is the only source). Served to clients by `GET <base>/config`.
 */
export interface AgentAttachmentsOptions {
  /** Per-file size cap. Defaults to 20 MiB. */
  maxBytes?: number;
  /**
   * Allowed multipart content types. Defaults to what multimodal model providers commonly accept:
   * `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `application/pdf`, `text/plain`, `text/csv`.
   */
  allowedContentTypes?: string[];
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
   * Supply one to add an axis this library has no key for: a sector, a region, a shift.
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
  /**
   * How an `action` tool waits for its approval. `'blocking'` (default): the turn parks on the
   * decision and resumes when it lands. `'independent'`: the call is recorded as an action proposal
   * and answered at once with a receipt (`{ proposalId, status: 'pending', executed: false }`), the
   * turn finishes, and a background worker runs the action once it is approved — decided through
   * `POST <base>/threads/:threadId/action-proposals/:proposalId/approve|reject`, the approval port or
   * a text command. Needs `backgroundActorResolver` and a store with the proposal capabilities
   * (both checked at boot). See `docs/independent-approvals.md`.
   */
  actionApprovalMode?: ActionApprovalMode;
  /**
   * Resolves the CURRENT actor (id, tenant, roles) for a proposal's recorded `actorRef`/`tenantRef`
   * when the worker runs it — there is no request to read an identity from. Return `null` for an
   * actor that no longer exists or no longer belongs to the tenant; the action then fails rather
   * than running. Required under `actionApprovalMode: 'independent'`.
   */
  backgroundActorResolver?: BackgroundActorResolver;
  /**
   * Tuning for the worker that runs approved proposals under `actionApprovalMode: 'independent'`
   * (started with the module unless `surface: 'http'`). `pollIntervalMs` — how often it looks for
   * queued work, default 1000; `leaseMs` — how long a claim holds before another worker may recover
   * it, default 30000; `maxConcurrency` — proposals claimed per poll, default 1. All positive
   * integers, and `pollIntervalMs` must stay below a third of `leaseMs`. `onSettled` runs after each
   * proposal the worker settles (executed or failed), with the stored proposal — its `outcome` and
   * `executionContext.pageContext` included; a module can subscribe the same way through
   * `ActionProposalWorkerService.onSettled`.
   */
  actionProposalWorker?: {
    pollIntervalMs?: number;
    leaseMs?: number;
    maxConcurrency?: number;
    onSettled?(proposal: ActionProposal): void | Promise<void>;
  };
  /**
   * The words a chat message must consist of to approve or reject a proposal by text, and what the
   * agent answers. English by default (`yes`/`confirm`/`approve`, `no`/`cancel`/`reject`, …); pass
   * `ptBrActionProposalText` from `@dudousxd/nestjs-agent-core` for Portuguese, or your own — either
   * part replaces the default it names, field by field.
   */
  actionProposalText?: TextActionProposalConfig;
  // --- infrastructure ---
  /**
   * The LLM provider — `aiSdkModel(openai('gpt-5-mini'))`, or `aiSdkModels({ … })` for a model
   * picker (its catalog is used when `models` is omitted). Required unless an `engine` runs the
   * turns instead.
   */
  model?: ModelProvider;
  /**
   * Run turns on something other than this library's loop — e.g. `openCode({ host })`. The engine
   * binds `AGENT_RUNNER`; the routes, store, sink, approvals and queue stay the library's. STATIC
   * wiring, like `durable` (see {@link AgentEngine}). Omit → the loop, on `model`.
   */
  engine?: AgentEngine;
  /**
   * The base prompt of the default agent (and of any `@Agent` that declares none) — a string, or a
   * function of the turn's `{ actor, agentName, pageContext }`. Omit → `'You are a helpful
   * assistant.'`.
   */
  systemPrompt?: string | PromptBuilder;
  /**
   * Persistence adapter. Omit it and either import a store module (e.g.
   * `MikroOrmAgentStoreModule.forFeature()`, which binds `AGENT_STORE` globally — it is found and
   * used), or run on the built-in in-memory store — fine for a demo, logged at boot as not for
   * production: threads vanish on restart and are not shared between processes.
   */
  store?: AgentStore;
  /** Live token transport. Defaults to a single-process in-memory sink. */
  sink?: TokenStreamSink;
  /**
   * The caller's budget. `{ limits: { day?: { tokens?, usd? }, month?: { tokens?, usd? } } }` puts
   * ceilings on the built-in ledger provider, and `warnAt` (`0..1`, e.g. `0.8`) a soft limit past
   * which the report carries a `warning`; a {@link QuotaProvider} of your own replaces it. Either
   * way `GET <base>/quota` reports it and a send whose report comes back `blocked` is refused with
   * `429` before the turn starts. Omit → reported (usage off the ledger), never enforced — for a
   * public (anonymous) deployment that means unbounded model spend, so set limits there; they apply
   * per actor, which is per browser in anonymous mode.
   */
  quota?: { limits: QuotaLimits; warnAt?: number } | QuotaProvider;
  /**
   * Which models a caller may pick — `GET <base>/models`, a send's `model`, a thread's pinned model
   * (`PATCH <base>/threads/:id { model }`). Omit → the catalog the model provider carries
   * (`aiSdkModels`), else none, and a request naming a model is refused.
   */
  models?: ModelCatalog;
  /** Tool authorization gate. Defaults to role-in-`defaultRoles`. */
  rolesPolicy?: RolesPolicy;
  /**
   * Who has to approve an `action` tool call, and how long the request stays open. Defaults to the
   * requester (the thread's own actor) with no expiry. A requirement naming another approver (a
   * role) is enforced by `POST tool-call/approve|reject` through `canDecide` — by default, the
   * deciding actor must hold that role. See `ApprovalPolicy`.
   */
  approvalPolicy?: ApprovalPolicy;
  /**
   * Roles a tool requires when its own `roles` is omitted. Default `[]` — no restriction: every
   * tool is callable by whoever `actorResolver` resolved (an anonymous visitor included, when none is
   * configured). `action` tools still park on approval regardless.
   */
  defaultRoles?: string[];
  /**
   * What an empty roles list means to the default `RolesPolicy`: `'allow'` (default) — no
   * restriction, so a tool that names no roles reaches every resolved actor; `'deny'` — nobody, so a
   * tool needs `roles` (or a non-empty `defaultRoles`) to be reachable. For an app where `[]` means
   * "no one" — a `roles` computed from permissions that can come out empty. Binds
   * `ClosedRolesPolicy`. Ignored when `rolesPolicy` is set.
   */
  emptyRoles?: EmptyRoles;
  /**
   * Resolves the acting actor for each request (the identity seam). Omit → the endpoints are public
   * and every browser is its own anonymous actor (`AnonymousActorResolver`: an `HttpOnly` cookie,
   * the actor id a digest of it), so visitors never see each other's threads, quota or attachments.
   * A boot notice says so. Require login with `requestUserActorResolver()` (reads `req.user`), or a
   * resolver of your own over your session / JWT / `nestjs-context`.
   */
  actorResolver?: ActorResolver;
  /** Route prefix the controllers mount under. Defaults to `'agent'` (→ `/agent/chat`, …). */
  path?: string;
  /**
   * Run each turn as a durable workflow instead of in-process. Requires importing
   * `AgentDurableModule` from `@dudousxd/nestjs-agent/durable` and a configured `DurableModule`.
   *
   * The turn's model call and its tool executions are dispatched steps
   * (`AgentRunSteps.llm` / `AgentRunSteps.tool`), so a `@AiTool` handler runs in whichever worker
   * serves the routed group rather than in the pod that took the request. A handler that resolves
   * anything per invocation from its caller's execution context — a request-scoped ORM
   * EntityManager, an AsyncLocalStorage tenant, a CLS transaction — must establish that context
   * itself (`@CreateRequestContext`/`@EnsureRequestContext` under MikroORM), exactly as a `@Step`
   * handler does.
   *
   * Multi-pod fleets MUST also wire a cross-process token sink (e.g. a Redis pub/sub
   * `TokenStreamSink`): the turn runs on whichever worker takes `agent.run`, which may not be the
   * pod holding the SSE connection.
   */
  durable?: boolean;
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
   * by actor). A convenience-vs-custom pair: this outranks a
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
   * quota, agents, attachments, config, …). Third-party controller
   * classes can't be annotated with `@UseGuards` by consumers, so without this option every route is
   * open beyond whatever `actorResolver` itself enforces. Guard classes are added to this module's
   * `providers` so Nest can DI-instantiate them; if a guard has its own dependencies, make sure they
   * resolve from this module's imports or a global module.
   */
  guards?: Type<CanActivate>[];

  /** Upload limits when the staging store declares none. Omit → 20 MiB and the default types. */
  attachments?: AgentAttachmentsOptions;

  /**
   * Which half of the module this process mounts (see {@link AgentSurface}). Omit → `'both'`,
   * today's behavior with zero change. STATIC top-level field (like `durable`/`path`) — it decides
   * which controllers exist at module-build time, not something a request can flip.
   */
  surface?: AgentSurface;

  /**
   * Wire protocols served alongside the native one, over the same runs — e.g. `[agUiAdapter()]`
   * mounts `POST <path>/ag-ui` (AG-UI 1.0). Their controllers mount under `path`, behind `guards`,
   * and not at all on `surface: 'engine'`. STATIC, like `surface`.
   */
  adapters?: AgentProtocolAdapter[];
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
   * Guard(s) applied uniformly to every controller this module mounts. A STATIC field on the async
   * config object itself — NOT part of what `useFactory` resolves — because controllers (and the
   * enhancers bound to them) are wired at module build time, before any async factory has run. If a
   * guard needs async-resolved config (e.g. a secret from a `ConfigService`), have the guard inject
   * that service via DI (see `imports`/`inject` above) rather than trying to thread it through
   * `useFactory`. Same default-open caveat as `AgentModuleOptions.guards`.
   */
  guards?: Type<CanActivate>[];

  /**
   * Which half of the module this process mounts (see {@link AgentSurface}). Same static-wiring
   * reasoning as `durable` above — `useFactory` resolves too late to decide
   * which controllers exist. Omit → `'both'`, today's behavior with zero change.
   */
  surface?: AgentSurface;
  /** Wire protocols served alongside the native one — see `AgentModuleOptions.adapters`. STATIC. */
  adapters?: AgentProtocolAdapter[];
  /**
   * What runs the turns instead of the loop — see `AgentModuleOptions.engine`. STATIC, like
   * `durable`: it decides which runner `AGENT_RUNNER` binds, before `useFactory` has resolved.
   */
  engine?: AgentEngine;
}
