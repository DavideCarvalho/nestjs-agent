export { AgentModule } from './agent.module.js';
export type {
  AgentModuleOptions,
  AgentModuleAsyncOptions,
  DefaultAgentOptions,
} from './agent.options.js';
export { AgentService, type ChatParams } from './agent.service.js';
export {
  AiTool,
  type AiToolOptions,
  AI_TOOL_METADATA,
  readAiToolMetadata,
} from './decorator/ai-tool.decorator.js';
export { AiToolDiscoveryService } from './discovery/ai-tool-discovery.service.js';
export {
  provideAgentTool,
  AGENT_TOOL_BRAND,
  type FunctionalTool,
} from './functional-tool.js';
export { InlineAgentRunner } from './runner/inline-agent-runner.js';
export { InProcessTokenStreamSink } from './in-process-sink.js';
export { type AgentDeps, utcDay } from './agent-deps.js';
export { AgentDepsFactory, delegateToolName } from './agent-deps.factory.js';
export { HeaderActorResolver } from './resolver/header-actor-resolver.js';
export { UnconfiguredActorResolver } from './resolver/unconfigured-actor-resolver.js';

// Re-export the core surface so consumers import tools/types from one place.
export * from '@dudousxd/nestjs-agent-core';
