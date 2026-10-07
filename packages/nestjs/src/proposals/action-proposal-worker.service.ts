import { randomUUID } from 'node:crypto';
import {
  AGENT_DEPS_FACTORY,
  AGENT_OPTIONS,
  AGENT_STORE,
  type ActionProposal,
  ActionProposalExecutor,
  ActionProposalWorker,
  type AgentStore,
  assertIndependentActionCapabilities,
} from '@dudousxd/nestjs-agent-core';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AgentDepsFactory } from '../agent-deps.factory.js';
import type { AgentModuleOptions } from '../agent.options.js';
/** Called with a proposal the worker just settled (executed, or failed executing). */
export type ActionProposalSettledListener = (proposal: ActionProposal) => void | Promise<void>;

@Injectable()
export class ActionProposalWorkerService implements OnModuleInit, OnModuleDestroy {
  private worker: ActionProposalWorker | undefined;
  private readonly logger = new Logger(ActionProposalWorkerService.name);
  private readonly settledListeners = new Set<ActionProposalSettledListener>();

  /**
   * Run `listener` after every proposal this process's worker settles — how a module relays an
   * outcome somewhere the turn's stream no longer reaches (a text channel's conversation). Next to
   * `actionProposalWorker.onSettled`; a listener that throws is logged and does not stop the others.
   * Returns the unsubscribe. Only the replicas that run the worker (not `surface: 'http'`) call it.
   */
  onSettled(listener: ActionProposalSettledListener): () => void {
    this.settledListeners.add(listener);
    return () => {
      this.settledListeners.delete(listener);
    };
  }

  private async settled(proposal: ActionProposal): Promise<void> {
    const configured = this.options.actionProposalWorker?.onSettled;
    for (const listener of [...(configured ? [configured] : []), ...this.settledListeners]) {
      try {
        await listener(proposal);
      } catch (error) {
        this.logger.error(error);
      }
    }
  }
  constructor(
    @Inject(AGENT_STORE) private readonly store: AgentStore,
    @Inject(AGENT_OPTIONS) private readonly options: AgentModuleOptions,
    @Inject(AGENT_DEPS_FACTORY) private readonly deps: AgentDepsFactory,
  ) {}
  onModuleInit() {
    if (this.options.actionApprovalMode !== 'independent') return;
    assertIndependentActionCapabilities(this.store, this.options.backgroundActorResolver);
    if (this.options.surface === 'http') return;
    const resolver = this.options.backgroundActorResolver;
    if (!resolver) throw new Error('BackgroundActorResolver is required');
    this.worker = new ActionProposalWorker({
      store: this.store,
      workerId: randomUUID(),
      ...this.options.actionProposalWorker,
      onSettled: (proposal) => this.settled(proposal),
      executor: new ActionProposalExecutor({
        resolver,
        resolveExecution: async (proposal, actor) => {
          const deps = this.deps.forProposal(proposal, actor);
          return {
            registry: deps.registry,
            rolesPolicy: deps.rolesPolicy,
            ...(deps.resolveUiCatalog !== undefined
              ? { resolveUiCatalog: deps.resolveUiCatalog }
              : {}),
            ...(deps.toolAllowList !== undefined ? { allowedTools: deps.toolAllowList } : {}),
          };
        },
      }),
      onError: (error) => this.logger.error(error),
    });
    this.worker.start();
  }
  async onModuleDestroy() {
    await this.worker?.stop();
  }
}
