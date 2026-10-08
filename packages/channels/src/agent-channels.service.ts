import { ActionProposalWorkerService, AgentService } from '@dudousxd/nestjs-agent';
import {
  AGENT_CHANNEL_STORE,
  AGENT_DURABLE_RUNNER,
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
import { ModuleRef } from '@nestjs/core';
import type { AgentChannelsModuleOptions } from './agent-channels.options.js';
import type { ChannelWorkflowEngine } from './executor.js';
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
 * calls {@link handle} when the module mounts no route (`path: false`). On init, when the agent runs
 * durably, the channels move onto the app's `WorkflowEngine` (see the `durable` option).
 */
@Injectable()
export class AgentChannelsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('AgentChannels');
  private readonly handlers = new Map<string, ChannelHandler>();
  private unsubscribe: (() => void) | undefined;

  constructor(
    @Inject(AGENT_CHANNELS_OPTIONS) private readonly options: AgentChannelsModuleOptions,
    @Inject(AgentService) service: ChannelTurnService,
    @Optional() @Inject(AGENT_CHANNEL_STORE) boundStore?: ChannelStore,
    @Optional()
    @Inject(ActionProposalWorkerService)
    private readonly worker?: ActionProposalWorkerService,
    @Optional() @Inject(ModuleRef) private readonly moduleRef?: ModuleRef,
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

  async onModuleInit(): Promise<void> {
    this.unsubscribe = this.worker?.onSettled((proposal) => this.relaySettled(proposal));
    // Registered on the engine before the first webhook — and before the engine recovers the
    // channel jobs a crash interrupted, which it runs only for workflows it knows.
    const engine = await this.durableEngine();
    if (engine !== undefined)
      for (const handler of this.handlers.values()) handler.useEngine(engine);
  }

  /**
   * The engine the channels run on: the one given, else the app's `WorkflowEngine` when the agent
   * runs durably (its durable runner is bound), else none (in this process).
   */
  private async durableEngine(): Promise<ChannelWorkflowEngine | undefined> {
    const { durable } = this.options;
    if (durable === false) return undefined;
    if (typeof durable === 'object') return durable;
    const resolve = <T>(token: unknown): T | undefined => {
      try {
        return this.moduleRef?.get(token as never, { strict: false }) as T | undefined;
      } catch {
        return undefined;
      }
    };
    const runsDurably = resolve(AGENT_DURABLE_RUNNER) !== undefined;
    // The durable packages are optional peers: looked up only when the agent runs on them.
    const core =
      runsDurably || durable === true
        ? await import('@dudousxd/nestjs-durable-core').catch(() => null)
        : null;
    const engine = core === null ? undefined : resolve<ChannelWorkflowEngine>(core.WorkflowEngine);
    if (engine === undefined && (durable === true || runsDurably))
      this.logger.warn(
        'The agent runs durably, but no WorkflowEngine could be resolved (import DurableModule, or pass `durable: engine`) — channel messages are handled in this process',
      );
    return engine;
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

  /**
   * Resolves once every message the channels took has been handled — for tests and shutdown. With a
   * durable engine: once their runs ended.
   */
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
