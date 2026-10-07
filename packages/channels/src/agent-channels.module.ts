import { type DynamicModule, Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { AgentChannelsController } from './agent-channels.controller.js';
import type {
  AgentChannelsModuleAsyncOptions,
  AgentChannelsModuleRootOptions,
} from './agent-channels.options.js';
import { AgentChannelsService } from './agent-channels.service.js';
import { AGENT_CHANNELS_OPTIONS } from './tokens.js';

/** Route the webhooks mount under when `path` is omitted. */
const DEFAULT_PATH = 'channels';

/**
 * The agent on text channels — WhatsApp (Evolution API, Cloud API), Telegram, or any
 * `ChannelAdapter`. One webhook route per channel that verifies, deduplicates, acknowledges at once
 * and answers in the background, with the channel's markdown, length limit and reply buttons;
 * proposals, questions and media included. Import it after `AgentModule`, whose (global)
 * `AgentService` it answers through.
 *
 * ```ts
 * imports: [
 *   AgentModule.forRoot({ …, actionApprovalMode: 'independent' }),
 *   AgentChannelsModule.forRoot({
 *     channels: [{
 *       adapter: telegram({ botToken, secretToken }),
 *       actor: (message) => accounts.forTelegram(message.from),
 *       thread: (actor, message) => threads.get(message.conversation),
 *       onThreadCreated: (threadId, actor, message) => threads.set(message.conversation, threadId),
 *     }],
 *   }),
 * ]
 * // POST /channels/telegram
 * ```
 */
@Module({})
export class AgentChannelsModule {
  static forRoot(options: AgentChannelsModuleRootOptions): DynamicModule {
    const { path, ...rest } = options;
    return {
      module: AgentChannelsModule,
      imports: routing(path),
      controllers: path === false ? [] : [AgentChannelsController],
      providers: [{ provide: AGENT_CHANNELS_OPTIONS, useValue: rest }, AgentChannelsService],
      exports: [AgentChannelsService],
    };
  }

  static forRootAsync(options: AgentChannelsModuleAsyncOptions): DynamicModule {
    return {
      module: AgentChannelsModule,
      imports: [...routing(options.path), ...(options.imports ?? [])],
      controllers: options.path === false ? [] : [AgentChannelsController],
      providers: [
        {
          provide: AGENT_CHANNELS_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        AgentChannelsService,
      ],
      exports: [AgentChannelsService],
    };
  }
}

/** Mount the controller under `path` (Nest applies the prefix to its relative routes). */
function routing(path: string | false | undefined): DynamicModule[] {
  return path === false
    ? []
    : [RouterModule.register([{ path: path ?? DEFAULT_PATH, module: AgentChannelsModule }])];
}
