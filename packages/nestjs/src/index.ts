export { AgentModule } from './agent.module.js';
export { AgentApprovalPortAdapter } from './approval-port.adapter.js';
export type {
  AgentModuleOptions,
  AgentModuleAsyncOptions,
  AgentAttachmentsOptions,
} from './agent.options.js';
export { AgentService, type ChatParams } from './agent.service.js';
export {
  AttachmentsController,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_ALLOWED_ATTACHMENT_CONTENT_TYPES,
} from './controller/attachments.controller.js';
export {
  AiTool,
  type AiToolOptions,
  AI_TOOL_METADATA,
  readAiToolMetadata,
} from './decorator/ai-tool.decorator.js';
export {
  Agent,
  type AgentOptions,
  AGENT_METADATA,
  readAgentMetadata,
} from './decorator/agent.decorator.js';
export {
  SystemPrompt,
  SystemPromptContributor,
  SYSTEM_PROMPT_METADATA,
  SYSTEM_PROMPT_CONTRIBUTOR_METADATA,
} from './decorator/system-prompt.decorator.js';
export { AiToolDiscoveryService } from './discovery/ai-tool-discovery.service.js';
export { AgentDiscoveryService } from './discovery/agent-discovery.service.js';
export {
  provideAgentTool,
  AGENT_TOOL_BRAND,
  type FunctionalTool,
} from './functional-tool.js';
export { InlineAgentRunner } from './runner/inline-agent-runner.js';
export { InProcessTokenStreamSink } from './in-process-sink.js';
export { LedgerQuotaStore } from './ledger-quota-store.js';
export { type AgentDeps, utcDay } from './agent-deps.js';
export { AgentDepsFactory, delegateToolName } from './agent-deps.factory.js';
export { HeaderActorResolver } from './resolver/header-actor-resolver.js';

// Re-export the core surface so consumers import tools/types from one place.
export * from '@dudousxd/nestjs-agent-core';
