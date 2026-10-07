import { ActionProposalWorkerService, AgentService } from '@dudousxd/nestjs-agent';
import {
  AGENT_CHANNEL_STORE,
  type ActionProposal,
  type ChannelStore,
  InMemoryChannelStore,
} from '@dudousxd/nestjs-agent-core';
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import type { AgentChannelsModuleOptions } from './agent-channels.options.js';
import {
  ChannelHandler,
  type ChannelHttpResponse,
  type ChannelTurnService,
  channelOfProposal,
} from './handler.js';
import {
  type ChannelHttpReply,
  type ChannelHttpRequest,
  channelRequestOf,
  sendChannelResponse,
} from './request.js';
import { AGENT_CHANNELS_OPTIONS } from './tokens.js';
import type { ChannelAdapter, ChannelRequest } from './types.js';

/**
 * The configured channels: answers their webhooks ({@link handle}), and relays the outcome of a
 * proposal made on one of them once the proposal worker settles it ({@link deliverOutcome}, wired to
 * `ActionProposalWorkerService.onSettled` on init). Injectable anywhere — a controller of your own
 * calls {@link handle} when the module mounts no route (`path: false`).
 */
@Injectable()
export class AgentChannelsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('AgentChannels');
  private readonly handlers = new Map<string, ChannelHandler>();
  private unsubscribe: (() => void) | undefined;

  constructor(
    @Inject(AGENT_CHANNELS_OPTIONS) options: AgentChannelsModuleOptions,
    @Inject(AgentService) service: ChannelTurnService,
    @Optional() @Inject(AGENT_CHANNEL_STORE) boundStore?: ChannelStore,
    @Optional()
    @Inject(ActionProposalWorkerService)
    private readonly worker?: ActionProposalWorkerService,
  ) {
    const store = options.store ?? boundStore ?? new InMemoryChannelStore();
    for (const channel of options.channels) {
      const { name } = channel.adapter;
      if (this.handlers.has(name)) throw new Error(`Two channels are named "${name}"`);
      this.handlers.set(
        name,
        new ChannelHandler(channel, service, store, (error) =>
          this.logger.error(
            `A message on "${name}" failed: ${error instanceof Error ? error.message : String(error)}`,
            error instanceof Error ? error.stack : undefined,
          ),
        ),
      );
    }
  }

  onModuleInit(): void {
    this.unsubscribe = this.worker?.onSettled((proposal) => this.relaySettled(proposal));
  }

  async onModuleDestroy(): Promise<void> {
    this.unsubscribe?.();
    await this.drain();
  }

  /** The adapter of the channel named `name`, if one is configured. */
  adapter(name: string): ChannelAdapter | undefined {
    return this.handlers.get(name)?.adapter;
  }

  /**
   * Answer one webhook of the channel named `name` — `404` when there is none. Framework-free: build
   * the {@link ChannelRequest} yourself, or use {@link handle}.
   */
  async handleRequest(name: string, request: ChannelRequest): Promise<ChannelHttpResponse> {
    const handler = this.handlers.get(name);
    if (handler === undefined) throw new NotFoundException(`No channel named "${name}"`);
    return handler.handle(request);
  }

  /**
   * Answer one webhook of the channel named `name` on an Express response or a Fastify reply — what
   * the module's route does, for a controller of your own:
   *
   * ```ts
   * @Post('whatsapp')
   * whatsapp(@Req() req: Request, @Res() res: Response) {
   *   return this.channels.handle('whatsapp', req, res);
   * }
   * ```
   */
  async handle(name: string, req: ChannelHttpRequest, res: ChannelHttpReply): Promise<void> {
    sendChannelResponse(res, await this.handleRequest(name, channelRequestOf(req)));
  }

  /**
   * Relay an executed proposal's outcome to the conversation it was proposed in, through the channel
   * recorded on it (`pageContext.channel`) — once, however many replicas or paths try. `false` when
   * it was not relayed: proposed elsewhere, a channel this process does not have, not executed, or
   * already relayed.
   */
  async deliverOutcome(proposal: ActionProposal): Promise<boolean> {
    const address = channelOfProposal(proposal);
    const handler = address === null ? undefined : this.handlers.get(address.name);
    if (address === null || handler === undefined) return false;
    return handler.relayOutcome(proposal, address.conversation);
  }

  /** Resolves once every turn the channels started has been answered — for tests and shutdown. */
  async drain(): Promise<void> {
    await Promise.all([...this.handlers.values()].map((handler) => handler.drain()));
  }

  private async relaySettled(proposal: ActionProposal): Promise<void> {
    try {
      await this.deliverOutcome(proposal);
    } catch (error) {
      this.logger.error(
        `The outcome of proposal ${proposal.id} could not be relayed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
