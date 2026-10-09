import {
  AGENT_MODEL,
  AGENT_OPTIONS,
  AGENT_PRICING_STORE,
  type AgentPricingStore,
  type ModelProvider,
  ensureModelPricing,
} from '@dudousxd/nestjs-agent-core';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import type { AgentModuleOptions } from './agent.options.js';

const logger = new Logger('AgentPricing');

/**
 * Makes sure every configured model records a cost, and says so when one will not (see
 * `AgentModuleOptions.priceCatalog`). Runs in the background once the app has bootstrapped — a slow
 * catalog must not hold the boot up — and never throws. Skipped under `NODE_ENV=test` unless
 * `priceCatalog` is set explicitly.
 */
@Injectable()
export class PricingBootService implements OnApplicationBootstrap, OnApplicationShutdown {
  #run: Promise<unknown> | null = null;

  constructor(
    @Inject(AGENT_OPTIONS) private readonly options: AgentModuleOptions,
    @Optional() @Inject(AGENT_MODEL) private readonly model: ModelProvider | undefined,
    // Bound externally (a store module), so optional like in AgentDepsFactory.
    @Optional()
    @Inject(AGENT_PRICING_STORE)
    private readonly pricingStore: AgentPricingStore | undefined,
  ) {}

  onApplicationBootstrap(): void {
    this.#run = this.check();
  }

  /** Awaits a check still in flight, so a test (or a fast shutdown) never leaks it. */
  async onApplicationShutdown(): Promise<void> {
    await this.#run;
    this.#run = null;
  }

  /** The check itself; resolves once it is done (exposed for tests). */
  async check(): Promise<void> {
    const models = this.model?.describeModels?.() ?? [];
    if (models.length === 0) return;
    const catalog = this.options.priceCatalog;
    if (catalog === undefined && process.env.NODE_ENV === 'test') return;
    await ensureModelPricing({
      models,
      pricingStore: this.pricingStore,
      catalog: catalog ?? {},
      log: {
        info: (message) => logger.log(message),
        warn: (message) => logger.warn(message),
      },
    }).catch(() => undefined);
  }
}
