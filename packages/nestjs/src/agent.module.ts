import {
  AGENT_ACTOR_RESOLVER,
  AGENT_DEPS_FACTORY,
  AGENT_DURABLE_RUNNER,
  AGENT_MODEL,
  AGENT_OPTIONS,
  AGENT_PROMPT_CONTRIBUTORS,
  AGENT_QUOTA_STORE,
  AGENT_REGISTRY,
  AGENT_ROLES_POLICY,
  AGENT_RUNNER,
  AGENT_SINK,
  AGENT_STORE,
  AGENT_TOOL_REGISTRY,
  AgentRegistry,
  type AgentRunner,
  type AgentStore,
  DefaultRolesPolicy,
  ToolRegistry,
} from '@dudousxd/nestjs-agent-core';
import {
  type CanActivate,
  type DynamicModule,
  Global,
  Module,
  type Provider,
  type Type,
} from '@nestjs/common';
import { DiscoveryModule, RouterModule } from '@nestjs/core';
import { AgentDepsFactory } from './agent-deps.factory.js';
import type { AgentModuleAsyncOptions, AgentModuleOptions } from './agent.options.js';
import { AgentService } from './agent.service.js';
import { AgentsController } from './controller/agents.controller.js';
import { AttachmentsController } from './controller/attachments.controller.js';
import { ChatController } from './controller/chat.controller.js';
import { QuotaController } from './controller/quota.controller.js';
import { ThreadsController } from './controller/threads.controller.js';
import { ToolCallController } from './controller/tool-call.controller.js';
import { AgentDiscoveryService } from './discovery/agent-discovery.service.js';
import { AiToolDiscoveryService } from './discovery/ai-tool-discovery.service.js';
import { InProcessTokenStreamSink } from './in-process-sink.js';
import { LedgerQuotaStore } from './ledger-quota-store.js';
import { InlineAgentRunner } from './runner/inline-agent-runner.js';

/** Default route prefix the controllers mount under. */
const DEFAULT_PATH = 'agent';

/**
 * The core wiring shared by `forRoot` / `forRootAsync`. `includeStore` controls whether we bind
 * `AGENT_STORE` locally: when the host omits `options.store` we leave it unbound so a globally-bound
 * store module (which binds `AGENT_STORE` app-wide) satisfies the dependency instead.
 */
function sharedProviders(durable: boolean, includeStore: boolean): Provider[] {
  const providers: Provider[] = [
    { provide: AGENT_TOOL_REGISTRY, useFactory: () => new ToolRegistry() },
    // Starts empty; AgentDiscoveryService populates it from `@Agent`-decorated providers at boot.
    { provide: AGENT_REGISTRY, useFactory: () => new AgentRegistry() },
    // A shared, mutable list AgentDiscoveryService fills with `@SystemPromptContributor()` methods.
    { provide: AGENT_PROMPT_CONTRIBUTORS, useFactory: () => [] },
    {
      provide: AGENT_SINK,
      useFactory: (options: AgentModuleOptions) => options.sink ?? new InProcessTokenStreamSink(),
      inject: [AGENT_OPTIONS],
    },
    {
      provide: AGENT_ROLES_POLICY,
      useFactory: (options: AgentModuleOptions) =>
        options.rolesPolicy ?? new DefaultRolesPolicy(options.defaultRoles),
      inject: [AGENT_OPTIONS],
    },
    {
      provide: AGENT_ACTOR_RESOLVER,
      useFactory: (options: AgentModuleOptions) => options.actorResolver,
      inject: [AGENT_OPTIONS],
    },
    {
      provide: AGENT_MODEL,
      useFactory: (o: AgentModuleOptions) => o.model,
      inject: [AGENT_OPTIONS],
    },
    {
      // An explicit `quota` wins; otherwise `quotaLimitTokens` binds the built-in ledger-backed
      // store; otherwise quotas are off (undefined). The ledger store reads the same usage rows
      // the loop already writes, so enforcement needs no extra shared state across replicas.
      provide: AGENT_QUOTA_STORE,
      useFactory: (o: AgentModuleOptions, store: AgentStore) =>
        o.quota ??
        (o.quotaLimitTokens !== undefined
          ? new LedgerQuotaStore(store, o.quotaLimitTokens)
          : undefined),
      inject: [AGENT_OPTIONS, AGENT_STORE],
    },
    AgentDepsFactory,
    { provide: AGENT_DEPS_FACTORY, useExisting: AgentDepsFactory },
    // Populates the registry + contributors (onModuleInit) BEFORE AiToolDiscoveryService synthesizes
    // handoff tools (onApplicationBootstrap) reads the registry.
    AgentDiscoveryService,
    AiToolDiscoveryService,
    InlineAgentRunner,
    AgentService,
  ];
  if (includeStore) {
    providers.push({
      provide: AGENT_STORE,
      useFactory: (o: AgentModuleOptions) => o.store,
      inject: [AGENT_OPTIONS],
    });
  }
  if (durable) {
    // Bind AGENT_RUNNER to the durable runner AgentDurableModule provides. Optional injection turns
    // a forgotten `AgentDurableModule` import into a clear error instead of an unresolved-dep crash.
    providers.push({
      provide: AGENT_RUNNER,
      useFactory: (durableRunner: AgentRunner | undefined) => {
        if (durableRunner === undefined) {
          throw new Error(
            'AgentModule.forRoot({ durable: true }) requires importing AgentDurableModule from ' +
              "'@dudousxd/nestjs-agent/durable' (alongside a configured DurableModule). It was not found.",
          );
        }
        return durableRunner;
      },
      inject: [{ token: AGENT_DURABLE_RUNNER, optional: true }],
    });
  } else {
    providers.push({ provide: AGENT_RUNNER, useExisting: InlineAgentRunner });
  }
  return providers;
}

/**
 * The module's public tokens. `AGENT_STORE` is only re-exported when we bind it locally — a module
 * cannot export a token it neither provides nor imports (the store module binds it globally instead).
 */
function exportsFor(includeStore: boolean): NonNullable<DynamicModule['exports']> {
  return [
    AGENT_OPTIONS,
    AGENT_TOOL_REGISTRY,
    AGENT_REGISTRY,
    AGENT_SINK,
    AGENT_ROLES_POLICY,
    AGENT_ACTOR_RESOLVER,
    AGENT_MODEL,
    ...(includeStore ? [AGENT_STORE] : []),
    AGENT_QUOTA_STORE,
    AGENT_PROMPT_CONTRIBUTORS,
    AGENT_DEPS_FACTORY,
    AgentDepsFactory,
    AgentService,
    InlineAgentRunner,
  ];
}

const BASE_CONTROLLERS = [
  ChatController,
  ThreadsController,
  ToolCallController,
  QuotaController,
  AgentsController,
];

/** Every controller class `guards` may ever target — stamped uniformly regardless of which of them are actually mounted this build (harmless: metadata on an unregistered class is simply unused). */
const GUARDABLE_CONTROLLERS = [...BASE_CONTROLLERS, AttachmentsController];

/** The controllers to mount: the base five, plus attachments when the host opted into uploads. */
function controllersFor(mountAttachments: boolean): Type<object>[] {
  return mountAttachments ? [...BASE_CONTROLLERS, AttachmentsController] : BASE_CONTROLLERS;
}

/**
 * Nest's `GUARDS_METADATA` key (`@nestjs/common/constants`), inlined as a literal: `@nestjs/common`
 * has no `exports` map and its ESM-facing files are CJS, so a deep `import ... from
 * '@nestjs/common/constants'` in our ESM build is emitted extensionless and rejected by Node's
 * strict ESM resolver (surfaced by a consumer's bundler/test runner externalizing this package).
 * `agent-guards.spec.ts` asserts this literal still matches the real constant, so upstream drift
 * fails loudly instead of silently stamping a dead metadata key.
 */
const GUARDS_METADATA = '__guards__';

/**
 * Stamp (or clear) `@UseGuards`-equivalent metadata on every controller this module MIGHT mount.
 *
 * Mechanism: `@UseGuards(...guards)` on a controller just does `Reflect.defineMetadata(GUARDS_METADATA,
 * guards, ControllerClass)` (via Nest's `extendArrayMetadata`, which *appends* to any existing array).
 * We call `Reflect.defineMetadata` directly instead, so each `forRoot`/`forRootAsync` call REPLACES
 * the metadata rather than appending to it — appending would leak guards across repeated module
 * registrations in the same process (every test file that calls `forRoot` more than once, say) since
 * these controller classes are module-level singletons shared by every registration. Nest's
 * `GuardsConsumer` reads this metadata per-request via `Reflector`, not once at boot, so the LAST call
 * to stamp it before a request is served wins for that controller class in this process.
 */
function applyGuards(guards: Type<CanActivate>[] | undefined): void {
  const resolved = guards ?? [];
  for (const controller of GUARDABLE_CONTROLLERS) {
    Reflect.defineMetadata(GUARDS_METADATA, resolved, controller);
  }
}

/** Distinct guard classes for the module's `providers`, so Nest can DI-instantiate them. */
function guardProviders(guards: Type<CanActivate>[] | undefined): Type<CanActivate>[] {
  return [...new Set(guards ?? [])];
}

/** Mount the controllers under `path` (Nest applies the prefix to their relative routes). */
function routerFor(path: string): DynamicModule {
  return RouterModule.register([{ path, module: AgentModule }]);
}

/**
 * `dispatchedSteps` routes the turn's model/tool calls through `AgentRunSteps` — a durable-only
 * worker group. Without `durable: true` there is no workflow to dispatch from, so this would silently
 * no-op; fail loudly at build time instead of at first request.
 */
function assertDispatchedStepsRequiresDurable(dispatchedSteps: boolean, durable: boolean): void {
  if (dispatchedSteps && !durable) {
    throw new Error(
      'AgentModule dispatchedSteps: true requires durable: true — dispatched steps are routed ' +
        'durable steps (AgentRunSteps.llm/tool) with no in-process equivalent.',
    );
  }
}

@Global()
@Module({})
export class AgentModule {
  static forRoot(options: AgentModuleOptions): DynamicModule {
    assertDispatchedStepsRequiresDurable(
      options.dispatchedSteps ?? false,
      options.durable ?? false,
    );
    const path = options.path ?? DEFAULT_PATH;
    // Bind AGENT_STORE locally only when the host passes a store; otherwise defer to a global one.
    const includeStore = options.store !== undefined;
    applyGuards(options.guards);
    return {
      module: AgentModule,
      global: true,
      imports: [DiscoveryModule, routerFor(path)],
      controllers: controllersFor(options.attachments?.upload === true),
      providers: [
        { provide: AGENT_OPTIONS, useValue: options },
        ...sharedProviders(options.durable ?? false, includeStore),
        ...guardProviders(options.guards),
      ],
      exports: exportsFor(includeStore),
    };
  }

  static forRootAsync(options: AgentModuleAsyncOptions): DynamicModule {
    assertDispatchedStepsRequiresDurable(
      options.dispatchedSteps ?? false,
      options.durable ?? false,
    );
    const path = options.path ?? DEFAULT_PATH;
    // The async factory resolves too late to inspect `store`, so `forRootAsync` binds AGENT_STORE
    // locally from the factory result by default. `externalStore: true` opts out — deferring to a
    // globally-imported store module (e.g. `MikroOrmAgentStoreModule.forFeature()`) so the host
    // doesn't have to inject that store just to hand it back as `store`.
    const includeStore = options.externalStore !== true;
    applyGuards(options.guards);
    return {
      module: AgentModule,
      global: true,
      imports: [DiscoveryModule, routerFor(path), ...(options.imports ?? [])],
      controllers: controllersFor(options.attachmentsUpload === true),
      providers: [
        {
          provide: AGENT_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        ...sharedProviders(options.durable ?? false, includeStore),
        ...guardProviders(options.guards),
      ],
      exports: exportsFor(includeStore),
    };
  }
}
