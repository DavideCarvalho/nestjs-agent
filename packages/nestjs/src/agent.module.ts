import {
  AGENT_ACTOR_RESOLVER,
  AGENT_APPROVAL_PORT,
  AGENT_DEPS_FACTORY,
  AGENT_DURABLE_RUNNER,
  AGENT_MEMORY,
  AGENT_MODEL,
  AGENT_MODEL_CATALOG,
  AGENT_OPTIONS,
  AGENT_PROMPT_CONTRIBUTORS,
  AGENT_QUOTA_PROVIDER,
  AGENT_REGISTRY,
  AGENT_ROLES_POLICY,
  AGENT_RUNNER,
  AGENT_SINK,
  AGENT_SKILLS,
  AGENT_SKILL_SOURCES,
  AGENT_STORE,
  AGENT_TOOL_REGISTRY,
  AgentRegistry,
  type AgentRunner,
  type AgentStore,
  DefaultRolesPolicy,
  InMemoryAgentStore,
  type ModelCatalog,
  type ModelProvider,
  type QuotaProvider,
  ToolRegistry,
} from '@dudousxd/nestjs-agent-core';
import {
  type CanActivate,
  type DynamicModule,
  Global,
  Logger,
  Module,
  type Provider,
  type Type,
} from '@nestjs/common';
import { DiscoveryModule, ModulesContainer, RouterModule } from '@nestjs/core';
import { AgentDepsFactory } from './agent-deps.factory.js';
import type { AgentModuleAsyncOptions, AgentModuleOptions, AgentSurface } from './agent.options.js';
import { AgentService } from './agent.service.js';
import { AgentApprovalPortAdapter } from './approval-port.adapter.js';
import { AgentsController } from './controller/agents.controller.js';
import { AttachmentsController } from './controller/attachments.controller.js';
import { ChatController } from './controller/chat.controller.js';
import { ConfigController } from './controller/config.controller.js';
import { MemoriesController } from './controller/memories.controller.js';
import { MessagesController } from './controller/messages.controller.js';
import { ModelsController } from './controller/models.controller.js';
import { QuotaController } from './controller/quota.controller.js';
import { SkillsController } from './controller/skills.controller.js';
import { ThreadsController } from './controller/threads.controller.js';
import { ToolCallController } from './controller/tool-call.controller.js';
import { ToolsController } from './controller/tools.controller.js';
import { AgentDiscoveryService } from './discovery/agent-discovery.service.js';
import { AiToolDiscoveryService } from './discovery/ai-tool-discovery.service.js';
import { type DeclaredSkill, SkillDiscoveryService } from './discovery/skill-discovery.service.js';
import { InProcessTokenStreamSink } from './in-process-sink.js';
import { LedgerQuotaProvider } from './ledger-quota-provider.js';
import { AnonymousActorResolver } from './resolver/anonymous-actor-resolver.js';
import { InlineAgentRunner } from './runner/inline-agent-runner.js';
import { resolveSkillsConfig } from './skills-config.js';

/** Default route prefix the controllers mount under. */
const DEFAULT_PATH = 'agent';

const logger = new Logger('AgentModule');

/**
 * `AGENT_STORE` as some OTHER module binds it — a store module (`MikroOrmAgentStoreModule`,
 * `DrizzleAgentStoreModule`, a host's own), found by scanning the container. Scanning sees every
 * module's providers before any is instantiated, so the answer is complete whatever the import
 * order; the instance itself is read lazily, at first use.
 */
function externalStoreWrapper(modules: ModulesContainer): { instance: unknown } | undefined {
  for (const module of modules.values()) {
    if (module.metatype === AgentModule) continue;
    const wrapper = module.providers.get(AGENT_STORE);
    if (wrapper !== undefined) return wrapper as { instance: unknown };
  }
  return undefined;
}

/** A store that forwards to another module's `AGENT_STORE`, resolved on first use. */
function forwardingStore(wrapper: { instance: unknown }): AgentStore {
  const target = (): Record<PropertyKey, unknown> => {
    const instance = wrapper.instance;
    if (instance === undefined || instance === null) {
      throw new Error('AgentModule: the AGENT_STORE bound by another module is not ready yet');
    }
    return instance as Record<PropertyKey, unknown>;
  };
  return new Proxy({} as AgentStore, {
    get(_, property) {
      const store = target();
      const value = store[property];
      return typeof value === 'function' ? value.bind(store) : value;
    },
    has(_, property) {
      return property in target();
    },
  });
}

/**
 * The store: the `store` option, else one another module binds, else the in-memory default — which
 * is loud about not being for production.
 */
function resolveStore(options: AgentModuleOptions, modules: ModulesContainer): AgentStore {
  if (options.store !== undefined) return options.store;
  const external = externalStoreWrapper(modules);
  if (external !== undefined) return forwardingStore(external);
  logger.warn(
    'No `store` configured and no store module imported — using the in-memory store. Threads are ' +
      'lost on restart and not shared between processes: not for production. Pass `store`, or ' +
      'import a store module (e.g. MikroOrmAgentStoreModule.forFeature()).',
  );
  return new InMemoryAgentStore();
}

function isQuotaProvider(quota: AgentModuleOptions['quota']): quota is QuotaProvider {
  return quota !== undefined && typeof (quota as QuotaProvider).report === 'function';
}

/** The model catalog: the `models` option, else the one the model provider carries (`aiSdkModels`). */
function resolveCatalog(options: AgentModuleOptions): ModelCatalog | undefined {
  if (options.models !== undefined) return options.models;
  const carried = (options.model as ModelProvider & { catalog?: ModelCatalog }).catalog;
  return carried !== undefined && typeof carried.list === 'function' ? carried : undefined;
}

/**
 * The core wiring shared by `forRoot` / `forRootAsync`. `includeStore` controls whether we bind
 * `AGENT_STORE` locally: when the host omits `options.store` we leave it unbound so a globally-bound
 * store module (which binds `AGENT_STORE` app-wide) satisfies the dependency instead.
 */
function sharedProviders(durable: boolean): Provider[] {
  const providers: Provider[] = [
    { provide: AGENT_TOOL_REGISTRY, useFactory: () => new ToolRegistry() },
    // Starts empty; AgentDiscoveryService populates it from `@Agent`-decorated providers at boot.
    { provide: AGENT_REGISTRY, useFactory: () => new AgentRegistry() },
    // A shared, mutable list AgentDiscoveryService fills with `@SystemPromptContributor()` methods.
    { provide: AGENT_PROMPT_CONTRIBUTORS, useFactory: () => [] },
    // Likewise for `@Skill`-decorated providers — filled by SkillDiscoveryService at onModuleInit,
    // read lazily by the AGENT_SKILLS provider below (which DI builds before discovery has run).
    { provide: AGENT_SKILL_SOURCES, useFactory: () => [] },
    {
      // One resolution, shared by the loop's deps and the listing endpoint: a second one would
      // drift, and a user would be offered a skill the agent cannot reach. `undefined` when the
      // host configured none — which is what keeps the turn's checkpoint sequence unchanged.
      provide: AGENT_SKILLS,
      useFactory: (options: AgentModuleOptions, declared: DeclaredSkill[]) =>
        resolveSkillsConfig(options.skills, declared),
      inject: [AGENT_OPTIONS, AGENT_SKILL_SOURCES],
    },
    {
      // One resolution, shared by the loop's deps and the read-back endpoint: a person has to be
      // shown what the model was shown, and two resolutions would eventually disagree about that.
      provide: AGENT_MEMORY,
      useFactory: (options: AgentModuleOptions) => options.memory,
      inject: [AGENT_OPTIONS],
    },
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
      useFactory: (options: AgentModuleOptions) => {
        if (options.actorResolver !== undefined) return options.actorResolver;
        logger.warn(
          'No `actorResolver` configured — the agent endpoints are PUBLIC: every browser gets its ' +
            'own anonymous identity (an HttpOnly cookie). Set `actorResolver: ' +
            'requestUserActorResolver()` (or your own) to require login.',
        );
        return new AnonymousActorResolver();
      },
      inject: [AGENT_OPTIONS],
    },
    {
      provide: AGENT_MODEL,
      useFactory: (o: AgentModuleOptions) => o.model,
      inject: [AGENT_OPTIONS],
    },
    {
      // `quota` is either a provider of the host's own or ceilings for the built-in ledger one;
      // omitted, the ledger provider still reports usage, with no ceiling to block on.
      provide: AGENT_QUOTA_PROVIDER,
      useFactory: (o: AgentModuleOptions, store: AgentStore) =>
        isQuotaProvider(o.quota) ? o.quota : new LedgerQuotaProvider(store, o.quota?.limits),
      inject: [AGENT_OPTIONS, AGENT_STORE],
    },
    {
      provide: AGENT_MODEL_CATALOG,
      useFactory: (o: AgentModuleOptions) => resolveCatalog(o),
      inject: [AGENT_OPTIONS],
    },
    AgentDepsFactory,
    { provide: AGENT_DEPS_FACTORY, useExisting: AgentDepsFactory },
    // Populates the registry + contributors (onModuleInit) BEFORE AiToolDiscoveryService synthesizes
    // handoff tools (onApplicationBootstrap) reads the registry.
    AgentDiscoveryService,
    AiToolDiscoveryService,
    SkillDiscoveryService,
    InlineAgentRunner,
    AgentService,
    // Bound ALWAYS (durable or inline) — the console's cross-thread approvals inbox routes decisions
    // through AgentService.signalToolCall, which reaches whichever AGENT_RUNNER is bound above.
    AgentApprovalPortAdapter,
    { provide: AGENT_APPROVAL_PORT, useExisting: AgentApprovalPortAdapter },
  ];
  providers.push({
    provide: AGENT_STORE,
    useFactory: (o: AgentModuleOptions, modules: ModulesContainer) => resolveStore(o, modules),
    inject: [AGENT_OPTIONS, ModulesContainer],
  });
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

/** The module's public tokens. */
function exportsFor(): NonNullable<DynamicModule['exports']> {
  return [
    AGENT_OPTIONS,
    AGENT_TOOL_REGISTRY,
    AGENT_REGISTRY,
    AGENT_SINK,
    AGENT_ROLES_POLICY,
    AGENT_ACTOR_RESOLVER,
    AGENT_MODEL,
    AGENT_STORE,
    AGENT_MODEL_CATALOG,
    AGENT_QUOTA_PROVIDER,
    AGENT_PROMPT_CONTRIBUTORS,
    AGENT_SKILLS,
    AGENT_MEMORY,
    AGENT_DEPS_FACTORY,
    AgentDepsFactory,
    AgentService,
    InlineAgentRunner,
    AGENT_APPROVAL_PORT,
  ];
}

const BASE_CONTROLLERS = [
  ChatController,
  ThreadsController,
  ToolCallController,
  QuotaController,
  AgentsController,
  SkillsController,
  MemoriesController,
  ToolsController,
  MessagesController,
  ModelsController,
  ConfigController,
  AttachmentsController,
];

/** Every controller class `guards` targets. */
const GUARDABLE_CONTROLLERS = BASE_CONTROLLERS;

/** `surface: 'engine'` mounts NO controllers — a worker pod never receives HTTP traffic. */
function controllersForSurface(surface: AgentSurface | undefined): Type<object>[] {
  return surface === 'engine' ? [] : BASE_CONTROLLERS;
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

@Global()
@Module({})
export class AgentModule {
  static forRoot(options: AgentModuleOptions): DynamicModule {
    const path = options.path ?? DEFAULT_PATH;
    applyGuards(options.guards);
    return {
      module: AgentModule,
      global: true,
      imports: [DiscoveryModule, routerFor(path)],
      controllers: controllersForSurface(options.surface),
      providers: [
        { provide: AGENT_OPTIONS, useValue: options },
        ...sharedProviders(options.durable ?? false),
        ...guardProviders(options.guards),
      ],
      exports: exportsFor(),
    };
  }

  static forRootAsync(options: AgentModuleAsyncOptions): DynamicModule {
    const path = options.path ?? DEFAULT_PATH;
    applyGuards(options.guards);
    return {
      module: AgentModule,
      global: true,
      imports: [DiscoveryModule, routerFor(path), ...(options.imports ?? [])],
      controllers: controllersForSurface(options.surface),
      providers: [
        {
          provide: AGENT_OPTIONS,
          // Stamp the STATIC wiring flags onto the factory result: `durable`/`surface` are
          // authoritative on the async config object (they decided the actual wiring above), and
          // the durable module reads `durable` back off AGENT_OPTIONS. `surface` isn't read back by
          // anything today (AgentDurableModule takes its own mirror option — see its doc for why),
          // but it's stamped here too so the EFFECTIVE value is always observable off
          // AGENT_OPTIONS, sync or async alike.
          useFactory: async (...args: never[]) => ({
            ...(await options.useFactory(...args)),
            durable: options.durable ?? false,
            surface: options.surface ?? 'both',
          }),
          inject: options.inject ?? [],
        },
        ...sharedProviders(options.durable ?? false),
        ...guardProviders(options.guards),
      ],
      exports: exportsFor(),
    };
  }
}
