export { AgentModule } from './agent.module.js';
export { AgentApprovalPortAdapter } from './approval-port.adapter.js';
export type {
  AgentModuleOptions,
  AgentModuleAsyncOptions,
  AgentAttachmentsOptions,
  AgentSkillsOptions,
  AgentMemoryOptions,
  AgentSurface,
} from './agent.options.js';
export {
  AgentService,
  type ChatParams,
  type ThreadDefaultAgentReader,
} from './agent.service.js';
export {
  AttachmentsController,
  ATTACHMENT_PAGE_SIZE,
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
  Skill,
  type SkillOptions,
  type SkillBody,
  SKILL_METADATA,
  readSkillMetadata,
  skillScope,
} from './decorator/skill.decorator.js';
export {
  SystemPrompt,
  SystemPromptContributor,
  SYSTEM_PROMPT_METADATA,
  SYSTEM_PROMPT_CONTRIBUTOR_METADATA,
} from './decorator/system-prompt.decorator.js';
export { AiToolDiscoveryService } from './discovery/ai-tool-discovery.service.js';
export { AgentDiscoveryService } from './discovery/agent-discovery.service.js';
export {
  SkillDiscoveryService,
  type DeclaredSkill,
} from './discovery/skill-discovery.service.js';
export { SkillsController } from './controller/skills.controller.js';
export { MemoriesController } from './controller/memories.controller.js';
export { declaredSkillProvider, resolveSkillsConfig } from './skills-config.js';
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
