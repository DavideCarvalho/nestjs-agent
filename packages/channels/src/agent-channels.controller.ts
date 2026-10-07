import { All, Controller, Inject, Param, Req, Res } from '@nestjs/common';
import { AgentChannelsService } from './agent-channels.service.js';
import type { ChannelHttpReply, ChannelHttpRequest } from './request.js';

/**
 * The channels' webhook routes, mounted under `AgentChannelsModule`'s `path` (default `channels`):
 * `/channels/<channel name>`, plus `/channels/<channel name>/:token` for a provider that carries its
 * secret in the url (Evolution API's `webhookToken`). Every method reaches the channel — WhatsApp
 * Cloud verifies its subscription with a `GET`; the rest answers `405`.
 */
@Controller()
export class AgentChannelsController {
  constructor(@Inject(AgentChannelsService) private readonly channels: AgentChannelsService) {}

  @All(':channel')
  webhook(
    @Param('channel') channel: string,
    @Req() req: ChannelHttpRequest,
    @Res() res: ChannelHttpReply,
  ): Promise<void> {
    return this.channels.handle(channel, req, res);
  }

  @All(':channel/:token')
  webhookWithToken(
    @Param('channel') channel: string,
    @Req() req: ChannelHttpRequest,
    @Res() res: ChannelHttpReply,
  ): Promise<void> {
    return this.channels.handle(channel, req, res);
  }
}
