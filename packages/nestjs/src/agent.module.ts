import {
  AGENT_MODEL,
  AGENT_OPTIONS,
  AGENT_QUOTA_STORE,
  AGENT_ROLES_POLICY,
  AGENT_RUNNER,
  AGENT_SINK,
  AGENT_STORE,
  AGENT_TOOL_REGISTRY,
  type AgentStore,
  DefaultRolesPolicy,
  type ModelProvider,
  type Persona,
  type QuotaStore,
  type RolesPolicy,
  type TokenStreamSink,
  ToolRegistry,
} from '@dudousxd/nestjs-agent-core';
import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AGENT_DEPS, type AgentDeps } from './agent-deps.js';
import type { AgentModuleAsyncOptions, AgentModuleOptions } from './agent.options.js';
import { AgentService } from './agent.service.js';
import { ChatController } from './controller/chat.controller.js';
import { QuotaController } from './controller/quota.controller.js';
import { ThreadsController } from './controller/threads.controller.js';
import { ToolCallController } from './controller/tool-call.controller.js';
import { AiToolDiscoveryService } from './discovery/ai-tool-discovery.service.js';
import { InProcessTokenStreamSink } from './in-process-sink.js';
import { InlineAgentRunner } from './runner/inline-agent-runner.js';

function buildDeps(
  options: AgentModuleOptions,
  registry: ToolRegistry,
  sink: TokenStreamSink,
  rolesPolicy: RolesPolicy,
  model: ModelProvider,
  store: AgentStore,
  quota: QuotaStore | undefined,
): AgentDeps {
  const personas = new Map<string, Persona>();
  for (const persona of options.personas ?? []) {
    personas.set(persona.id, persona);
  }
  return {
    model,
    store,
    registry,
    rolesPolicy,
    sink,
    modelId: options.modelId,
    systemPrompt: options.systemPrompt ?? 'You are a helpful assistant.',
    maxSteps: options.maxSteps ?? 8,
    personas,
    defaultPersona: options.defaultPersona ?? 'default',
    ...(quota !== undefined ? { quota } : {}),
  };
}

function sharedProviders(durable: boolean): Provider[] {
  const providers: Provider[] = [
    { provide: AGENT_TOOL_REGISTRY, useFactory: () => new ToolRegistry() },
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
    {
      provide: AGENT_DEPS,
      useFactory: buildDeps,
      inject: [
        AGENT_OPTIONS,
        AGENT_TOOL_REGISTRY,
        AGENT_SINK,
        AGENT_ROLES_POLICY,
        AGENT_MODEL,
        AGENT_STORE,
        AGENT_QUOTA_STORE,
      ],
    },
    AiToolDiscoveryService,
    InlineAgentRunner,
    AgentService,
  ];
  // When durable, AgentDurableModule (from '@dudousxd/nestjs-agent/durable') binds AGENT_RUNNER.
  if (!durable) {
    providers.push({ provide: AGENT_RUNNER, useExisting: InlineAgentRunner });
  }
  return providers;
}

const EXPORTS = [
  AGENT_OPTIONS,
  AGENT_TOOL_REGISTRY,
  AGENT_SINK,
  AGENT_ROLES_POLICY,
  AGENT_MODEL,
  AGENT_STORE,
  AGENT_QUOTA_STORE,
  AGENT_DEPS,
  AgentService,
  InlineAgentRunner,
];

@Global()
@Module({})
export class AgentModule {
  static forRoot(options: AgentModuleOptions): DynamicModule {
    return {
      module: AgentModule,
      imports: [DiscoveryModule],
      controllers: [ChatController, ThreadsController, ToolCallController, QuotaController],
      providers: [{ provide: AGENT_OPTIONS, useValue: options }, ...sharedProviders(options.durable ?? false)],
      exports: EXPORTS,
    };
  }

  static forRootAsync(options: AgentModuleAsyncOptions): DynamicModule {
    return {
      module: AgentModule,
      imports: [DiscoveryModule, ...((options.imports as DynamicModule['imports']) ?? [])],
      controllers: [ChatController, ThreadsController, ToolCallController, QuotaController],
      providers: [
        {
          provide: AGENT_OPTIONS,
          useFactory: options.useFactory,
          inject: (options.inject as never[]) ?? [],
        },
        // Durability is decided at runtime here; controllers always mount and AGENT_RUNNER is
        // bound to the inline runner unless AgentDurableModule rebinds it.
        ...sharedProviders(false),
      ],
      exports: EXPORTS,
    };
  }
}
