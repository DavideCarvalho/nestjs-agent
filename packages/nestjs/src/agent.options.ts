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
  /** Daily token budget. Optional — omit to disable quotas. */
  quota?: QuotaStore;
  /** Tool authorization gate. Defaults to role-in-`defaultRoles`. */
  rolesPolicy?: RolesPolicy;
  /** Default roles a tool requires when its `roles` is omitted. Defaults to `['ADMIN']`. */
  defaultRoles?: string[];
  /**
   * Resolves the acting actor for each request (the identity seam). No default fabricates a
   * caller — when omitted, every request throws until you provide a resolver (or the opt-in
   * `HeaderActorResolver`). Required for anything beyond a throw-on-call placeholder.
   */
  actorResolver?: ActorResolver;
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
}
