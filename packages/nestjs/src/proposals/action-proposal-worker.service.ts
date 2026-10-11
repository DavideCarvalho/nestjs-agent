import { randomUUID } from 'node:crypto';
import {
  AGENT_DEPS_FACTORY,
  AGENT_OPTIONS,
  AGENT_STORE,
  type ActionProposal,
  ActionProposalExecutor,
  type ActionProposalOutcome,
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
/** Called with a proposal outcome the worker just wrote to its thread. */
export type ActionProposalAdmittedListener = (
  outcome: ActionProposalOutcome,
) => void | Promise<void>;

@Injectable()
export class ActionProposalWorkerService implements OnModuleInit, OnModuleDestroy {
  private worker: ActionProposalWorker | undefined;
  private readonly logger = new Logger(ActionProposalWorkerService.name);
  private readonly settledListeners = new Set<ActionProposalSettledListener>();
  private readonly admittedListeners = new Set<ActionProposalAdmittedListener>();

  /**
   * Run `listener` once a settled proposal's outcome is written to its thread by this process's
   * worker (the thread was free) — what a module uses to CONTINUE a conversation once an action it
   * proposed ran (a Poppy connect: the next turn goes on with what was asked). Next to
   * `actionProposalWorker.onAdmitted`; a listener that throws is logged and does not stop the
   * others. Returns the unsubscribe.
   */
  onAdmitted(listener: ActionProposalAdmittedListener): () => void {
    this.admittedListeners.add(listener);
    return () => {
      this.admittedListeners.delete(listener);
    };
  }

  private async admitted(outcome: ActionProposalOutcome): Promise<void> {
    const configured = this.options.actionProposalWorker?.onAdmitted;
    for (const listener of [...(configured ? [configured] : []), ...this.admittedListeners]) {
      try {
        await listener(outcome);
      } catch (error) {
        this.logger.error(error);
      }
    }
  }

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
      onAdmitted: (outcome) => this.admitted(outcome),
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
