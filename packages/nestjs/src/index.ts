export { AgentModule } from './agent.module.js';
export type { AgentModuleOptions, AgentModuleAsyncOptions } from './agent.options.js';
export { AgentService, type ChatParams } from './agent.service.js';
export { AiTool, type AiToolOptions, AI_TOOL_METADATA, readAiToolMetadata } from './decorator/ai-tool.decorator.js';
export { AiToolDiscoveryService } from './discovery/ai-tool-discovery.service.js';
export { InlineAgentRunner } from './runner/inline-agent-runner.js';
export { InProcessTokenStreamSink } from './in-process-sink.js';
export { AGENT_DEPS, type AgentDeps, utcDay } from './agent-deps.js';
export { resolveActor } from './util/actor.js';

// Re-export the core surface so consumers import tools/types from one place.
export * from '@dudousxd/nestjs-agent-core';
