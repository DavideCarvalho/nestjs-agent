import {
  AGENT_MODEL,
  AGENT_QUOTA_STORE,
  AGENT_REGISTRY,
  AGENT_ROLES_POLICY,
  AGENT_SINK,
  AGENT_STORE,
  AGENT_TOOL_REGISTRY,
  type AgentDefinition,
  AgentRegistry,
  type AgentStore,
  type ModelProvider,
  type Persona,
  type QuotaStore,
  type RolesPolicy,
  type TokenStreamSink,
  ToolRegistry,
} from '@dudousxd/nestjs-agent-core';
import { AGENT_OPTIONS } from '@dudousxd/nestjs-agent-core';
import { Inject, Injectable } from '@nestjs/common';
import type { AgentDeps } from './agent-deps.js';
import type { AgentModuleOptions } from './agent.options.js';

/** The synthesized `agent`-kind tool name an orchestrator uses to delegate to `target`. */
export function delegateToolName(target: string): string {
  return `ask_${target.replace(/[^a-zA-Z0-9]+/g, '_')}`;
}

/** Builds the per-agent loop deps. The single-agent case is just the `default` definition. */
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
    @Inject(AGENT_QUOTA_STORE) private readonly quota: QuotaStore | undefined,
  ) {}

  defaultAgentName(): string {
    return this.options.defaultAgent?.name ?? 'default';
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
    const personas = new Map<string, Persona>();
    for (const persona of definition?.personas ?? []) {
      personas.set(persona.id, persona);
    }
    const toolAllowList = this.effectiveTools(definition);
    const followUpsCount = this.followUpsCount();
    return {
      model: this.model,
      store: this.store,
      sink: this.sink,
      rolesPolicy: this.rolesPolicy,
      registry: this.registry,
      systemPrompt: definition?.systemPrompt ?? 'You are a helpful assistant.',
      maxSteps: definition?.maxSteps ?? 8,
      personas,
      defaultPersona: definition?.defaultPersona ?? 'default',
      ...(definition?.modelId !== undefined ? { modelId: definition.modelId } : {}),
      ...(this.quota !== undefined ? { quota: this.quota } : {}),
      ...(toolAllowList !== undefined ? { toolAllowList } : {}),
      ...(this.options.toolTimeoutMs !== undefined
        ? { toolTimeoutMs: this.options.toolTimeoutMs }
        : {}),
      ...(followUpsCount !== undefined ? { followUpsCount } : {}),
    };
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
