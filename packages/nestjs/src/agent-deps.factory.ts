import {
  AGENT_MEMORY,
  AGENT_MODEL,
  AGENT_PRICING_STORE,
  AGENT_PROMPT_CONTRIBUTORS,
  AGENT_REGISTRY,
  AGENT_ROLES_POLICY,
  AGENT_SINK,
  AGENT_SKILLS,
  AGENT_STORE,
  AGENT_TOOL_REGISTRY,
  type AgentDefinition,
  type AgentHistoryWindow,
  type AgentPricingStore,
  AgentRegistry,
  type AgentStore,
  type HistoryPolicy,
  type MemoryConfig,
  type ModelProvider,
  type Persona,
  type PersonaCatalogEntry,
  type PromptBuilder,
  type PromptContext,
  type PromptContributor,
  type RolesPolicy,
  type SkillsConfig,
  type TokenStreamSink,
  ToolRegistry,
  findPersona,
  intersectAllowLists,
  normalizeDelegation,
  personaCatalogEntry,
  resolvePersonaAlias,
  summarizeWithModel,
  windowHistory,
} from '@dudousxd/nestjs-agent-core';
import { AGENT_OPTIONS } from '@dudousxd/nestjs-agent-core';
import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import type { AgentDeps } from './agent-deps.js';
import type { AgentModuleOptions } from './agent.options.js';

/**
 * The synthesized `agent`-kind tool name an orchestrator uses to hand off to `target`.
 *
 * A detached edge gets its own verb — `start_research` next to `ask_research` — for two reasons.
 * One agent can be both awaited AND backgrounded by the same orchestrator, and one name cannot
 * carry both. And the name is the part of a tool the model reads first: `ask` promises an answer,
 * `start` does not.
 */
export function delegateToolName(args: { target: string; detached?: boolean }): string {
  const slug = args.target.replace(/[^a-zA-Z0-9]+/g, '_');
  return args.detached === true ? `start_${slug}` : `ask_${slug}`;
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
    // Optional: AGENT_PRICING_STORE has no local provider in this module — it's bound externally
    // (e.g. by a store module), so a plain @Inject would throw when nothing binds it.
    @Optional()
    @Inject(AGENT_PRICING_STORE)
    private readonly pricingStore: AgentPricingStore | undefined,
    // Optional for the same reason, plus one of its own: `undefined` is the CONFIGURED state for a
    // host that declared no skills, not an unbound dependency.
    @Optional()
    @Inject(AGENT_SKILLS)
    private readonly skills: SkillsConfig | undefined,
    // Optional for the same reason: `undefined` is the CONFIGURED state for a host that wired no
    // memory, not an unbound dependency.
    @Optional()
    @Inject(AGENT_MEMORY)
    private readonly memory: MemoryConfig | undefined,
  ) {}

  /** The turn's memory seam, shared with the read-back endpoint. Undefined → memory is not configured. */
  memoryConfig(): MemoryConfig | undefined {
    return this.memory;
  }

  /** The turn's skills seam, shared with the listing endpoint. Undefined → skills are not configured. */
  skillsConfig(): SkillsConfig | undefined {
    return this.skills;
  }

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
    const delegated = (definition.delegatesTo ?? []).map((edge) => {
      const { agent, detached } = normalizeDelegation(edge);
      return delegateToolName({ target: agent, detached });
    });
    if (definition.tools === undefined && delegated.length === 0) {
      return undefined; // no restriction
    }
    return [...(definition.tools ?? []), ...delegated];
  }

  /**
   * The agent a name stands for: itself when it is a registered agent (or unknown — the bare
   * assistant), else the agent whose persona took the name over (`Persona.aliases`) and that persona.
   */
  resolveAgent(name: string): { agentName: string; persona?: string } {
    if (this.agents.has(name)) {
      return { agentName: name };
    }
    const alias = resolvePersonaAlias(this.agents.list(), name);
    return alias === undefined
      ? { agentName: name }
      : { agentName: alias.agent, persona: alias.persona };
  }

  /** `agentName`'s personas as a picker reads them. Empty when it declares none. */
  personaCatalog(agentName: string): PersonaCatalogEntry[] {
    return (this.agents.get(agentName)?.personas ?? []).map(personaCatalogEntry);
  }

  /** The persona `agentName` runs under when nothing names one. Undefined → none. */
  defaultPersona(agentName: string): string | undefined {
    return this.agents.get(agentName)?.defaultPersona;
  }

  /**
   * The persona a turn of `agentName` runs under, most specific first: the one the send names
   * (refused with `400 persona_not_found` when the agent does not declare it), else the thread's
   * pinned one when this agent declares it, else the agent's default. Undefined → none.
   */
  resolvePersona(args: {
    agentName: string;
    requested?: string;
    threadPersona?: string | null;
  }): string | undefined {
    const definition = this.agents.get(args.agentName);
    if (args.requested !== undefined) {
      if (findPersona(definition, args.requested) === undefined) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'persona_not_found',
          message: `agent "${args.agentName}" has no persona "${args.requested}"`,
        });
      }
      return args.requested;
    }
    const pinned = args.threadPersona ?? undefined;
    if (pinned !== undefined && findPersona(definition, pinned) !== undefined) {
      return pinned;
    }
    return definition?.defaultPersona;
  }

  forAgent(agentName?: string): AgentDeps {
    const name = agentName ?? this.defaultAgentName();
    if (agentName !== undefined && !this.agents.has(agentName)) {
      const alias = resolvePersonaAlias(this.agents.list(), agentName);
      const persona =
        alias === undefined ? undefined : findPersona(this.agents.get(alias.agent), alias.persona);
      if (alias !== undefined && persona !== undefined) {
        return this.withPersona(this.forAgent(alias.agent), persona);
      }
    }
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
      ...(this.options.approvalPolicy !== undefined
        ? { approvalPolicy: this.options.approvalPolicy }
        : {}),
      registry: this.registry,
      promptContributors: this.promptContributors,
      systemPrompt:
        definition?.systemPrompt ?? this.options.systemPrompt ?? 'You are a helpful assistant.',
      maxSteps: definition?.maxSteps ?? 8,
      ...(definition?.maxDelegationDepth !== undefined
        ? { maxDelegationDepth: definition.maxDelegationDepth }
        : {}),
      ...(definition?.maxAgentAppearances !== undefined
        ? { maxAgentAppearances: definition.maxAgentAppearances }
        : {}),
      ...(definition?.modelId !== undefined ? { modelId: definition.modelId } : {}),
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
      // Module-wide, never per-agent: a skill is a procedure, not a persona, and an agent that could
      // opt out of one would make the catalog depend on which agent a turn happened to select — a
      // per-turn fact the worker re-deriving the tool list cannot see.
      ...(this.skills !== undefined ? { skills: this.skills } : {}),
      // Module-wide, never per-agent, for the same reason skills are: which memories a turn carries
      // cannot depend on which persona answered it, or the worker re-deriving a dispatched turn's
      // tool list would disagree with the loop about whether `remember` was offered.
      ...(this.memory !== undefined ? { memory: this.memory } : {}),
      ...(toolAllowList !== undefined ? { toolAllowList } : {}),
      ...(definition?.personas !== undefined ? { personas: definition.personas } : {}),
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
   * A persona baked into an agent's deps — how a run journaled under an agent name that a persona
   * has since taken over (`Persona.aliases`) is served. That run names no persona of its own (it
   * predates them, and its input cannot change), so the persona applies the way the old agent's own
   * config did: as config, re-read on every replay, with no checkpoint of its own.
   */
  private withPersona(deps: AgentDeps, persona: Persona): AgentDeps {
    const base = deps.systemPrompt;
    const ref = { id: persona.id, label: persona.label };
    const resolve = async (prompt: string | PromptBuilder, ctx: PromptContext) =>
      typeof prompt === 'function' ? prompt(ctx) : prompt;
    const own = persona.systemPrompt;
    const systemPrompt: PromptBuilder = async (ctx) => {
      const scoped: PromptContext = { ...ctx, persona: ref };
      if (own === undefined) {
        return resolve(base, scoped);
      }
      const basePrompt = typeof own === 'function' ? await resolve(base, scoped) : undefined;
      return resolve(own, { ...scoped, ...(basePrompt !== undefined ? { basePrompt } : {}) });
    };
    const toolAllowList = intersectAllowLists(deps.toolAllowList, persona.allowedTools);
    return { ...deps, systemPrompt, ...(toolAllowList !== undefined ? { toolAllowList } : {}) };
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
