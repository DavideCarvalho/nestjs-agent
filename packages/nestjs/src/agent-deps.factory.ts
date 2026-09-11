import {
  AGENT_MODEL,
  AGENT_PRICING_STORE,
  AGENT_PROMPT_CONTRIBUTORS,
  AGENT_QUOTA_STORE,
  AGENT_REGISTRY,
  AGENT_ROLES_POLICY,
  AGENT_SINK,
  AGENT_STORE,
  AGENT_TOOL_REGISTRY,
  type AgentDefinition,
  type AgentHistoryWindow,
  type AgentPricingStore,
  AgentRegistry,
  type AgentStore,
  type HistoryPolicy,
  type ModelProvider,
  type PromptContributor,
  type QuotaStore,
  type RolesPolicy,
  type TokenStreamSink,
  ToolRegistry,
  summarizeWithModel,
  windowHistory,
} from '@dudousxd/nestjs-agent-core';
import { AGENT_OPTIONS } from '@dudousxd/nestjs-agent-core';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { AgentDeps } from './agent-deps.js';
import type { AgentModuleOptions } from './agent.options.js';

/** The synthesized `agent`-kind tool name an orchestrator uses to hand off to `target`. */
export function delegateToolName(target: string): string {
  return `ask_${target.replace(/[^a-zA-Z0-9]+/g, '_')}`;
}

/** Builds the per-agent loop deps. The single-agent case is just the one registered `@Agent`. */
@Injectable()
export class AgentDepsFactory {
  constructor(
    @Inject(AGENT_OPTIONS) private readonly options: AgentModuleOptions,
    @Inject(AGENT_MODEL) private readonly model: ModelProvider,
    @Inject(AGENT_STORE) private readonly store: AgentStore,
    @Inject(AGENT_SINK) private readonly sink: TokenStreamSink,
    @Inject(AGENT_ROLES_POLICY) private readonly rolesPolicy: RolesPolicy,
    @Inject(AGENT_TOOL_REGISTRY) private readonly registry: ToolRegistry,
    @Inject(AGENT_REGISTRY) private readonly agents: AgentRegistry,
    @Inject(AGENT_PROMPT_CONTRIBUTORS) private readonly promptContributors: PromptContributor[],
    @Inject(AGENT_QUOTA_STORE) private readonly quota: QuotaStore | undefined,
    // Optional: AGENT_PRICING_STORE has no local provider in this module (unlike AGENT_QUOTA_STORE,
    // which is always a registered factory) — it's bound externally (e.g. by a store module), so a
    // plain @Inject would throw when nothing binds it.
    @Optional()
    @Inject(AGENT_PRICING_STORE)
    private readonly pricingStore: AgentPricingStore | undefined,
  ) {}

  /**
   * The agent a turn uses when the caller names none: the explicit `defaultAgent` option, else the
   * sole registered `@Agent` when there is exactly one, else `'default'` (a bare assistant).
   */
  defaultAgentName(): string {
    if (this.options.defaultAgent !== undefined) {
      return this.options.defaultAgent;
    }
    const registered = this.agents.list();
    return registered.length === 1 ? (registered[0]?.name ?? 'default') : 'default';
  }

  private effectiveTools(definition: AgentDefinition | undefined): string[] | undefined {
    if (definition === undefined) {
      return undefined;
    }
    const delegated = (definition.delegatesTo ?? []).map(delegateToolName);
    if (definition.tools === undefined && delegated.length === 0) {
      return undefined; // no restriction
    }
    return [...(definition.tools ?? []), ...delegated];
  }

  forAgent(agentName?: string): AgentDeps {
    const name = agentName ?? this.defaultAgentName();
    const definition = this.agents.get(name);
    const toolAllowList = this.effectiveTools(definition);
    const followUpsCount = this.followUpsCount();
    const retrieval = this.options.retrieval;
    const historyPolicy = this.historyPolicy(definition);
    const ask = definition?.ask ?? this.options.ask;
    return {
      model: this.model,
      store: this.store,
      sink: this.sink,
      rolesPolicy: this.rolesPolicy,
      registry: this.registry,
      promptContributors: this.promptContributors,
      systemPrompt: definition?.systemPrompt ?? 'You are a helpful assistant.',
      maxSteps: definition?.maxSteps ?? 8,
      ...(definition?.modelId !== undefined ? { modelId: definition.modelId } : {}),
      ...(this.quota !== undefined ? { quota: this.quota } : {}),
      ...(this.pricingStore !== undefined ? { pricingStore: this.pricingStore } : {}),
      ...(historyPolicy !== undefined ? { historyPolicy } : {}),
      inputProcessors: this.options.inputProcessors ?? [],
      outputProcessors: this.options.outputProcessors ?? [],
      ...(definition?.outputSchema !== undefined ? { outputSchema: definition.outputSchema } : {}),
      ...(definition?.outputRepairAttempts !== undefined
        ? { outputRepairAttempts: definition.outputRepairAttempts }
        : {}),
      ...(definition?.intake !== undefined ? { intake: definition.intake } : {}),
      // Most specific wins, exactly as `historyPolicy` resolves: the agent's own `@Agent({ ask })`,
      // else the module-wide flag. Both are module config, so every process of a deployment agrees.
      ...(ask === true ? { ask: true } : {}),
      ...(toolAllowList !== undefined ? { toolAllowList } : {}),
      ...(this.options.toolTimeoutMs !== undefined
        ? { toolTimeoutMs: this.options.toolTimeoutMs }
        : {}),
      ...(this.options.toolTransientRetry !== undefined
        ? { toolTransientRetry: this.options.toolTransientRetry }
        : {}),
      ...(followUpsCount !== undefined ? { followUpsCount } : {}),
      ...(retrieval?.mode === 'inject'
        ? {
            retriever: retrieval.retriever,
            ...(retrieval.topK !== undefined ? { retrievalTopK: retrieval.topK } : {}),
          }
        : {}),
    };
  }

  /**
   * The ceiling on how much of a thread this agent's turns carry, most specific wins: the agent's
   * own `@Agent({ history })`, else a module-wide custom `historyPolicy`, else the module-wide
   * `history` window. Undefined → unbounded, the behaviour of a module that configures none.
   */
  private historyPolicy(definition: AgentDefinition | undefined): HistoryPolicy | undefined {
    if (definition?.history !== undefined) {
      return this.window(definition.history);
    }
    if (this.options.historyPolicy !== undefined) {
      return this.options.historyPolicy;
    }
    return this.options.history === undefined ? undefined : this.window(this.options.history);
  }

  /** Build the built-in window policy from the declarative `{ maxMessages, maxTokens, summarize }`. */
  private window(config: AgentHistoryWindow): HistoryPolicy {
    return windowHistory({
      ...(config.maxMessages !== undefined ? { maxMessages: config.maxMessages } : {}),
      ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
      // The shared module model, not a per-agent one: an agent's `modelId` is an accounting label,
      // and only one provider is ever bound.
      ...(config.summarize === true ? { summarize: summarizeWithModel(this.model) } : {}),
    });
  }

  /** Normalize the `followUps` option (`true` → 3, `{ count }` → count) to a number, or undefined. */
  private followUpsCount(): number | undefined {
    const followUps = this.options.followUps;
    if (followUps === true) {
      return 3;
    }
    if (typeof followUps === 'object') {
      return followUps.count;
    }
    return undefined;
  }
}
