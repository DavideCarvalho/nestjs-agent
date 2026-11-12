import {
  AGENT_OPTIONS,
  type DescribedModel,
  type ModelCatalog,
  type ModelCatalogQuery,
  type ModelCatalogView,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  type PriceCatalogEntry,
  staticCatalogView,
} from '@dudousxd/nestjs-agent-core';
import { AI_MODULE_OPTIONS, AiModels, type AiModuleOptions } from '@nestjs/ai';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ResilienceService } from '@nestjs/resilience';
import type { AgentModuleOptions } from '../agent.options.js';
import { type NestAiModelProvider, nestAiModelProvider } from './nest-ai-model-provider.js';

/**
 * The agent's model when `AgentModule` is given none: `@nestjs/ai`'s `AiModule`, found wherever the
 * application imports it (it need not be global, nor imported next to `AgentModule`). Resolved once
 * every provider exists (`onModuleInit`); a turn, the picker and boot pricing all come after that.
 */
@Injectable()
export class NestAiModelsBinding implements ModelProvider, OnModuleInit {
  #provider: NestAiModelProvider | undefined;

  constructor(
    @Inject(AGENT_OPTIONS) private readonly options: AgentModuleOptions,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Whether the agent's turns run on `AiModule`'s models (no `model` and no `engine` configured). */
  get active(): boolean {
    return this.options.model === undefined && this.options.engine === undefined;
  }

  onModuleInit(): void {
    if (!this.active) return;
    const models = this.find<AiModels>(AiModels);
    const options = this.find<AiModuleOptions>(AI_MODULE_OPTIONS);
    if (models === undefined || options === undefined) {
      throw new Error(
        'AgentModule: no `model` is configured, and no AiModule was found. Import ' +
          "`AiModule.forRoot({ models: { default: anthropic('claude-sonnet-4-5') } })` from '@nestjs/ai' " +
          '(the agent runs on its models), pass `model`, or set an `engine`.',
      );
    }
    const resilience = this.find<ResilienceService>(ResilienceService);
    this.#provider = nestAiModelProvider({
      models,
      options,
      ...(resilience !== undefined ? { resilience } : {}),
    });
  }

  /** The picker's catalog, read through to `AiModule`'s models once they are resolved. */
  readonly catalog: ModelCatalog & { readonly view: ModelCatalogView | undefined } = ((
    binding: NestAiModelsBinding,
  ) => ({
    list: (query: ModelCatalogQuery): ModelCatalogView | Promise<ModelCatalogView> =>
      binding.provider.catalog.list(query),
    // `AiModule`'s models are one fixed list: what the boot check reads agents' `model`s against.
    get view(): ModelCatalogView | undefined {
      const provider = binding.#provider;
      return provider === undefined ? undefined : staticCatalogView(provider.catalog);
    },
  }))(this);

  runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    return this.provider.runTurn(args);
  }

  describeModels(): DescribedModel[] {
    return this.#provider?.describeModels?.() ?? [];
  }

  /** `AiModule`'s `pricing`, as price rows boot pricing seeds. */
  prices(): PriceCatalogEntry[] {
    return this.#provider?.prices() ?? [];
  }

  private get provider(): NestAiModelProvider {
    if (this.#provider === undefined) {
      throw new Error(
        'AgentModule: the AiModule models are not resolved yet (before onModuleInit).',
      );
    }
    return this.#provider;
  }

  private find<T>(token: unknown): T | undefined {
    try {
      return this.moduleRef.get<T>(token as never, { strict: false }) ?? undefined;
    } catch {
      return undefined;
    }
  }
}
