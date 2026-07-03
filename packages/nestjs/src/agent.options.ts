import type {
  ActorResolver,
  AgentStore,
  ModelProvider,
  Persona,
  QuotaStore,
  RolesPolicy,
  TokenStreamSink,
} from '@dudousxd/nestjs-agent-core';

export interface AgentModuleOptions {
  /** The LLM provider (e.g. a Vercel AI SDK wrapper). Required. */
  model: ModelProvider;
  /** Persistence adapter. Required. */
  store: AgentStore;
  /** Model id recorded with usage/cost. Required. */
  modelId: string;
  /** Live token transport. Defaults to a single-process in-memory sink. */
  sink?: TokenStreamSink;
  /**
   * Resolves the acting {@link ActorResolver} for each request (the identity seam). No default
   * fabricates a caller — when omitted, every request throws until you provide a resolver (or the
   * opt-in `HeaderActorResolver`). Required for anything beyond a throw-on-call placeholder.
   */
  actorResolver?: ActorResolver;
  /** Tool authorization gate. Defaults to role-in-`defaultRoles`. */
  rolesPolicy?: RolesPolicy;
  /** Default roles a tool requires when its `roles` is omitted. Defaults to `['ADMIN']`. */
  defaultRoles?: string[];
  /** Daily token budget. Optional — omit to disable quotas. */
  quota?: QuotaStore;
  /** Base system prompt used when a persona does not override it. */
  systemPrompt?: string;
  /** Available personas (id → prompt + tool allow-list). */
  personas?: Persona[];
  /** Persona id used when a request does not name one. Defaults to `'default'`. */
  defaultPersona?: string;
  /** Max model↔tool iterations per turn. Defaults to 8. */
  maxSteps?: number;
  /** Name of the implicit single agent built from these options. Defaults to `'default'`. */
  defaultAgent?: string;
  /**
   * Run each turn as a durable workflow instead of in-process. Requires importing
   * `AgentDurableModule` from `@dudousxd/nestjs-agent/durable` and a configured `DurableModule`.
   */
  durable?: boolean;
}

export interface AgentModuleAsyncOptions {
  imports?: unknown[];
  inject?: unknown[];
  useFactory: (...args: never[]) => AgentModuleOptions | Promise<AgentModuleOptions>;
}
