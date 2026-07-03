import {
  AGENT_ACTOR_RESOLVER,
  AGENT_DEPS_FACTORY,
  AGENT_DURABLE_RUNNER,
  AGENT_MODEL,
  AGENT_OPTIONS,
  AGENT_QUOTA_STORE,
  AGENT_REGISTRY,
  AGENT_ROLES_POLICY,
  AGENT_RUNNER,
  AGENT_SINK,
  AGENT_STORE,
  AGENT_TOOL_REGISTRY,
  type AgentDefinition,
  AgentRegistry,
  type AgentRunner,
  DefaultRolesPolicy,
  ToolRegistry,
} from '@dudousxd/nestjs-agent-core';
import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { DiscoveryModule, RouterModule } from '@nestjs/core';
import { AgentDepsFactory } from './agent-deps.factory.js';
import type { AgentModuleAsyncOptions, AgentModuleOptions } from './agent.options.js';
import { AgentService } from './agent.service.js';
import { ChatController } from './controller/chat.controller.js';
import { QuotaController } from './controller/quota.controller.js';
import { ThreadsController } from './controller/threads.controller.js';
import { ToolCallController } from './controller/tool-call.controller.js';
import { AiToolDiscoveryService } from './discovery/ai-tool-discovery.service.js';
import { InProcessTokenStreamSink } from './in-process-sink.js';
import { UnconfiguredActorResolver } from './resolver/unconfigured-actor-resolver.js';
import { InlineAgentRunner } from './runner/inline-agent-runner.js';

const FEATURE_INIT = Symbol('nestjs-agent:feature-init');

/** Default route prefix the controllers mount under. */
const DEFAULT_PATH = 'agent';

/**
 * The implicit single agent, built from `options.defaultAgent`. `DefaultAgentOptions` is exactly an
 * `AgentDefinition` with `name` optional, so we just default the name and spread the rest. forFeature
 * adds more named agents.
 */
function defaultDefinition(options: AgentModuleOptions): AgentDefinition {
  return { name: 'default', ...options.defaultAgent };
}

function sharedProviders(durable: boolean): Provider[] {
  const providers: Provider[] = [
    { provide: AGENT_TOOL_REGISTRY, useFactory: () => new ToolRegistry() },
    {
      provide: AGENT_REGISTRY,
      useFactory: (options: AgentModuleOptions) => {
        const registry = new AgentRegistry();
        registry.register(defaultDefinition(options));
        return registry;
      },
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
      useFactory: (options: AgentModuleOptions) =>
        options.actorResolver ?? new UnconfiguredActorResolver(),
      inject: [AGENT_OPTIONS],
    },
    {
      provide: AGENT_MODEL,
      useFactory: (o: AgentModuleOptions) => o.model,
      inject: [AGENT_OPTIONS],
    },
    {
      provide: AGENT_STORE,
      useFactory: (o: AgentModuleOptions) => o.store,
      inject: [AGENT_OPTIONS],
    },
    {
      provide: AGENT_QUOTA_STORE,
      useFactory: (o: AgentModuleOptions) => o.quota,
      inject: [AGENT_OPTIONS],
    },
    AgentDepsFactory,
    { provide: AGENT_DEPS_FACTORY, useExisting: AgentDepsFactory },
    AiToolDiscoveryService,
    InlineAgentRunner,
    AgentService,
  ];
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

const EXPORTS = [
  AGENT_OPTIONS,
  AGENT_TOOL_REGISTRY,
  AGENT_REGISTRY,
  AGENT_SINK,
  AGENT_ROLES_POLICY,
  AGENT_ACTOR_RESOLVER,
  AGENT_MODEL,
  AGENT_STORE,
  AGENT_QUOTA_STORE,
  AGENT_DEPS_FACTORY,
  AgentDepsFactory,
  AgentService,
  InlineAgentRunner,
];

const CONTROLLERS = [ChatController, ThreadsController, ToolCallController, QuotaController];

/** Mount the controllers under `path` (Nest applies the prefix to their relative routes). */
function routerFor(path: string): DynamicModule {
  return RouterModule.register([{ path, module: AgentModule }]);
}

@Global()
@Module({})
export class AgentModule {
  static forRoot(options: AgentModuleOptions): DynamicModule {
    const path = options.path ?? DEFAULT_PATH;
    return {
      module: AgentModule,
      global: true,
      imports: [DiscoveryModule, routerFor(path)],
      controllers: CONTROLLERS,
      providers: [
        { provide: AGENT_OPTIONS, useValue: options },
        ...sharedProviders(options.durable ?? false),
      ],
      exports: EXPORTS,
    };
  }

  static forRootAsync(options: AgentModuleAsyncOptions): DynamicModule {
    const path = options.path ?? DEFAULT_PATH;
    return {
      module: AgentModule,
      global: true,
      imports: [
        DiscoveryModule,
        routerFor(path),
        ...((options.imports as DynamicModule['imports']) ?? []),
      ],
      controllers: CONTROLLERS,
      providers: [
        {
          provide: AGENT_OPTIONS,
          useFactory: options.useFactory,
          inject: (options.inject as never[]) ?? [],
        },
        ...sharedProviders(false),
      ],
      exports: EXPORTS,
    };
  }

  /** Register additional named agents (an orchestrator + its sub-agents). */
  static forFeature(definitions: AgentDefinition[]): DynamicModule {
    return {
      module: AgentModule,
      providers: [
        {
          provide: FEATURE_INIT,
          useFactory: (registry: AgentRegistry) => {
            for (const definition of definitions) {
              registry.register(definition);
            }
            return true;
          },
          inject: [AGENT_REGISTRY],
        },
      ],
    };
  }
}
