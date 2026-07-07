import type {
  ActorResolver,
  AgentDefinition,
  AgentStore,
  ModelProvider,
  QuotaStore,
  RolesPolicy,
  TokenStreamSink,
} from '@dudousxd/nestjs-agent-core';
import type { FunctionalTool } from './functional-tool.js';

/**
 * The implicit default agent, configured inline on `forRoot`. It is an {@link AgentDefinition}
 * with `name` optional (defaults to `'default'`) — everything agent-shaped is an AgentDefinition,
 * whether it's this default or one registered via `forFeature`. Omit it entirely for a bare
 * assistant with no base prompt, personas, or tool allow-list.
 */
export type DefaultAgentOptions = Omit<AgentDefinition, 'name'> & { name?: string };

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
   * Static functional tools (`{ spec, handler }`, e.g. from `createExecuteSqlTool`) to register at
   * boot. For tools that need DI-resolved dependencies, use `provideAgentTool(factory, inject)` in a
   * module's `providers` instead.
   */
  tools?: FunctionalTool[];

  // --- the default agent (optional) ---
  /**
   * The implicit single agent's config (base prompt, personas, tool allow-list, model/step
   * config). Omit for a bare assistant. Additional named agents are added via `forFeature`.
   */
  defaultAgent?: DefaultAgentOptions;
}

export interface AgentModuleAsyncOptions {
  imports?: unknown[];
  inject?: unknown[];
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
}
