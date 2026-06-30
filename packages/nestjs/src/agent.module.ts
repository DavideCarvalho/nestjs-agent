import {
  AGENT_DEPS_FACTORY,
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
  DefaultRolesPolicy,
  ToolRegistry,
} from '@dudousxd/nestjs-agent-core';
import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AgentDepsFactory } from './agent-deps.factory.js';
import type { AgentModuleAsyncOptions, AgentModuleOptions } from './agent.options.js';
import { AgentService } from './agent.service.js';
import { ChatController } from './controller/chat.controller.js';
import { QuotaController } from './controller/quota.controller.js';
import { ThreadsController } from './controller/threads.controller.js';
import { ToolCallController } from './controller/tool-call.controller.js';
import { AiToolDiscoveryService } from './discovery/ai-tool-discovery.service.js';
import { InProcessTokenStreamSink } from './in-process-sink.js';
import { InlineAgentRunner } from './runner/inline-agent-runner.js';

const FEATURE_INIT = Symbol('nestjs-agent:feature-init');

/** The implicit single agent, built from the module options. forFeature adds more named agents. */
function defaultDefinition(options: AgentModuleOptions): AgentDefinition {
  return {
    name: options.defaultAgent ?? 'default',
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    modelId: options.modelId,
    ...(options.personas !== undefined ? { personas: options.personas } : {}),
    ...(options.defaultPersona !== undefined ? { defaultPersona: options.defaultPersona } : {}),
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
  };
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
    { provide: AGENT_MODEL, useFactory: (o: AgentModuleOptions) => o.model, inject: [AGENT_OPTIONS] },
    { provide: AGENT_STORE, useFactory: (o: AgentModuleOptions) => o.store, inject: [AGENT_OPTIONS] },
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
  if (!durable) {
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
  AGENT_MODEL,
  AGENT_STORE,
  AGENT_QUOTA_STORE,
  AGENT_DEPS_FACTORY,
  AgentDepsFactory,
  AgentService,
  InlineAgentRunner,
];

@Global()
@Module({})
export class AgentModule {
  static forRoot(options: AgentModuleOptions): DynamicModule {
    return {
      module: AgentModule,
      global: true,
      imports: [DiscoveryModule],
      controllers: [ChatController, ThreadsController, ToolCallController, QuotaController],
      providers: [
        { provide: AGENT_OPTIONS, useValue: options },
        ...sharedProviders(options.durable ?? false),
      ],
      exports: EXPORTS,
    };
  }

  static forRootAsync(options: AgentModuleAsyncOptions): DynamicModule {
    return {
      module: AgentModule,
      global: true,
      imports: [DiscoveryModule, ...((options.imports as DynamicModule['imports']) ?? [])],
      controllers: [ChatController, ThreadsController, ToolCallController, QuotaController],
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
