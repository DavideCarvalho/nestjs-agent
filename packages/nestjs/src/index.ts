export { AgentModule } from './agent.module.js';
export { type AgUiAdapterOptions, AgUiRunHandler, agUiAdapter } from './ag-ui/index.js';
export type { AgentProtocolAdapter } from './protocol-adapter.js';
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
  type ChatSendMode,
  type ChatSendResult,
  type QueuedSend,
  type ThreadDefaultAgentReader,
  type ThreadModelReader,
} from './agent.service.js';
export { type ThreadPersonaReader, threadPersona } from './thread-persona.js';
export {
  AttachmentsController,
  ATTACHMENT_PAGE_SIZE,
} from './controller/attachments.controller.js';
export {
  type AttachmentLimits,
  attachmentLimits,
  DEFAULT_ALLOWED_ATTACHMENT_CONTENT_TYPES,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from './attachment-limits.js';
export { ConfigController } from './controller/config.controller.js';
export {
  AiTool,
  type AiToolOptions,
  AI_TOOL_METADATA,
  readAiToolMetadata,
  type ResolvedAiToolOptions,
  toolNameFromClass,
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
export { MessagesController } from './controller/messages.controller.js';
export { ModelsController } from './controller/models.controller.js';
export { ToolsController } from './controller/tools.controller.js';
export { MemoriesController } from './controller/memories.controller.js';
export { declaredSkillProvider, resolveSkillsConfig } from './skills-config.js';
export {
  defineTool,
  type FunctionalToolDefinition,
  provideAgentTool,
  provideAgentTools,
  AGENT_TOOL_BRAND,
  type FunctionalTool,
} from './functional-tool.js';
export { InlineAgentRunner } from './runner/inline-agent-runner.js';
export { QueueController } from './controller/queue.controller.js';
export {
  ChatQueueService,
  type QueuePlan,
  type QueueSettleOutcome,
  type QueuedTurn,
  type QueuedTurnStarter,
} from './queue/chat-queue.service.js';
export { AGENT_CHAT_QUEUE } from './queue/chat-queue.token.js';
export { InProcessTokenStreamSink } from './in-process-sink.js';
export {
  LedgerQuotaProvider,
  type QuotaLimits,
  type QuotaWindowLimits,
} from './ledger-quota-provider.js';
export { type AgentDeps, utcDay } from './agent-deps.js';
export { AgentDepsFactory, delegateToolName } from './agent-deps.factory.js';
export { HeaderActorResolver } from './resolver/header-actor-resolver.js';
export {
  AnonymousActorResolver,
  type AnonymousActorOptions,
} from './resolver/anonymous-actor-resolver.js';
export {
  defaultRequestUserMapper,
  requestUserActorResolver,
  type RequestUserMapper,
} from './resolver/request-user-actor-resolver.js';

// Re-export the core surface so consumers import tools/types from one place.
export * from '@dudousxd/nestjs-agent-core';
export { RunNotActiveException } from './run-not-active.exception.js';
export { ActionProposalService } from './proposals/action-proposal.service.js';
export { ActionProposalController } from './proposals/action-proposal.controller.js';
export { ActionProposalWorkerService } from './proposals/action-proposal-worker.service.js';
