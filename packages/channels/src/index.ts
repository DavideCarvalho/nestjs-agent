/**
 * `@dudousxd/nestjs-agent-channels` — the agent on text channels (WhatsApp, Telegram, …): one webhook
 * route per channel that verifies, deduplicates, acknowledges at once and answers in the background,
 * with the channel's markdown, length limit and reply buttons; proposals, questions and media too.
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
export { type TelegramOptions, telegram } from './adapters/telegram.js';
export { type WhatsappCloudOptions, whatsappCloud } from './adapters/whatsapp-cloud.js';
export {
  type ChannelAddress,
  ChannelHandler,
  type ChannelHttpResponse,
  type ChannelMediaRefusal,
  type ChannelOptions,
  type ChannelProposal,
  type ChannelTexts,
  type ChannelTextsOverrides,
  type ChannelTurnService,
  channelOfProposal,
  DEFAULT_CHANNEL_TEXTS,
  mergeChannelTexts,
  proposalButtonIds,
} from './handler.js';
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
} from './questions.js';
export { splitMessage } from './split.js';
export type {
  ChannelAdapter,
  ChannelButton,
  ChannelCapabilities,
  ChannelChallengeResponse,
  ChannelMarkdown,
  ChannelMediaFile,
  ChannelRequest,
  InboundMedia,
  InboundMessage,
  OutboundMessage,
} from './types.js';
// The store contract lives in core, where the store packages implement it.
export { type ChannelStore, InMemoryChannelStore } from '@dudousxd/nestjs-agent-core';
