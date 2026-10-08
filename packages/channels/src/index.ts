/**
 * `@dudousxd/nestjs-agent-channels` — the agent on text channels (WhatsApp, Telegram, …): one webhook
 * route per channel that verifies, deduplicates, acknowledges at once and answers in the background
 * (durably, one message at a time per conversation, on a `@dudousxd/nestjs-durable` engine), with the
 * channel's markdown, length limit, reply buttons and files; proposals, questions, media and hooks.
 */
export { AgentChannelsModule } from './agent-channels.module.js';
export { AgentChannelsService } from './agent-channels.service.js';
export { AgentChannelsController } from './agent-channels.controller.js';
export type {
  AgentChannelsModuleAsyncOptions,
  AgentChannelsModuleOptions,
  AgentChannelsModuleRootOptions,
} from './agent-channels.options.js';
export { AGENT_CHANNELS_OPTIONS } from './tokens.js';
export { type EvolutionApiOptions, evolutionApi } from './adapters/evolution-api.js';
export { type WhatsmiauOptions, whatsmiau } from './adapters/whatsmiau.js';
export { type TelegramOptions, telegram } from './adapters/telegram.js';
export { type WhatsappCloudOptions, whatsappCloud } from './adapters/whatsapp-cloud.js';
export {
  type ChannelAddress,
  type ChannelDelivery,
  type ChannelGate,
  ChannelHandler,
  type ChannelHookContext,
  type ChannelHttpResponse,
  type ChannelInbound,
  type ChannelOptions,
  type ChannelPreparedMedia,
  type ChannelReply,
  type ChannelSettledProposal,
  type ChannelTurnService,
  type ChannelTurnStarted,
  type ChannelWebhookEvent,
  channelOfProposal,
  proposalButtonIds,
} from './handler.js';
export {
  type ChannelComponent,
  type ChannelMediaRefusal,
  type ChannelProposal,
  type ChannelTexts,
  type ChannelTextsOverrides,
  channelTextsFor,
  DEFAULT_CHANNEL_TEXTS,
  mergeChannelTexts,
  ptBrChannelTexts,
} from './texts.js';
export {
  type ChannelExecutor,
  type ChannelJob,
  type ChannelRetryOptions,
  type ChannelWorkflowCtx,
  type ChannelWorkflowEngine,
  retryableByDefault,
} from './executor.js';
export {
  type ChannelHttpReply,
  type ChannelHttpRequest,
  channelRequestOf,
  sendChannelResponse,
} from './request.js';
export { ChannelDeliveryError, type ChannelFetch, ChannelMediaTooLargeError } from './http.js';
export {
  escapeTelegramMarkdown,
  toChannelMarkdown,
  unescapeTelegramMarkdown,
} from './markdown.js';
export {
  type ChannelAnswer,
  type ChannelQuestionTexts,
  DEFAULT_CHANNEL_QUESTION_TEXTS,
  formatChannelQuestion,
  parseChannelAnswer,
  ptBrChannelQuestionTexts,
} from './questions.js';
export { splitMessage } from './split.js';
export type {
  ChannelAdapter,
  ChannelButton,
  ChannelCapabilities,
  ChannelChallengeResponse,
  ChannelIgnored,
  ChannelMarkdown,
  ChannelMediaFile,
  ChannelRequest,
  InboundMedia,
  InboundMessage,
  OutboundMedia,
  OutboundMessage,
} from './types.js';
// The store contract lives in core, where the store packages implement it.
export { type ChannelStore, InMemoryChannelStore } from '@dudousxd/nestjs-agent-core';
