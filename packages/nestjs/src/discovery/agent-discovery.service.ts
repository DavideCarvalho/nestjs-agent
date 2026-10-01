import {
  AGENT_PROMPT_CONTRIBUTORS,
  AGENT_REGISTRY,
  type AgentDefinition,
  type AgentDelegation,
  AgentRegistry,
  type PromptBuilder,
  type PromptContext,
  type PromptContributor,
} from '@dudousxd/nestjs-agent-core';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { type AgentOptions, readAgentMetadata } from '../decorator/agent.decorator.js';
import {
  SYSTEM_PROMPT_CONTRIBUTOR_METADATA,
  SYSTEM_PROMPT_METADATA,
} from '../decorator/system-prompt.decorator.js';

/**
 * Populates the {@link AgentRegistry} from `@Agent`-decorated providers and collects every
 * `@SystemPromptContributor()` method into the app-wide contributor list — the discovery counterpart
 * to authoring agents as config objects. Runs on `onModuleInit`, so agents/contributors are in place
 * before `AiToolDiscoveryService` (which synthesizes handoff tools) runs its `onApplicationBootstrap`.
 */
@Injectable()
export class AgentDiscoveryService implements OnModuleInit {
  private readonly logger = new Logger(AgentDiscoveryService.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    @Inject(AGENT_REGISTRY) private readonly registry: AgentRegistry,
    @Inject(AGENT_PROMPT_CONTRIBUTORS) private readonly contributors: PromptContributor[],
  ) {}

  onModuleInit(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance;
      if (instance === null || typeof instance !== 'object') {
        continue;
      }
      const meta = readAgentMetadata(instance.constructor);
      if (meta !== undefined) {
        this.registry.register(this.definitionFrom(instance, meta));
      }
      this.collectContributors(instance);
    }
    this.assertPersonas(this.registry.list());
  }

  /** Build the internal {@link AgentDefinition} from an `@Agent` instance and its options. */
  private definitionFrom(instance: object, meta: AgentOptions): AgentDefinition {
    const promptMethod = this.methodWith(instance, SYSTEM_PROMPT_METADATA);
    const systemPrompt: string | PromptBuilder =
      promptMethod !== undefined
        ? (ctx: PromptContext) => promptMethod(ctx) as string | Promise<string>
        : (meta.systemPrompt ?? 'You are a helpful assistant.');
    return {
      name: meta.name,
      ...(meta.description !== undefined ? { description: meta.description } : {}),
      systemPrompt,
      ...(meta.tools !== undefined ? { tools: meta.tools } : {}),
      ...(meta.model !== undefined ? { modelId: meta.model } : {}),
      ...(meta.maxSteps !== undefined ? { maxSteps: meta.maxSteps } : {}),
      ...(meta.maxDelegationDepth !== undefined
        ? { maxDelegationDepth: meta.maxDelegationDepth }
        : {}),
      ...(meta.maxAgentAppearances !== undefined
        ? { maxAgentAppearances: meta.maxAgentAppearances }
        : {}),
      ...(meta.history !== undefined ? { history: meta.history } : {}),
      ...(meta.outputSchema !== undefined ? { outputSchema: meta.outputSchema } : {}),
      ...(meta.intake !== undefined ? { intake: meta.intake } : {}),
      ...(meta.ask !== undefined ? { ask: meta.ask } : {}),
      ...(meta.outputRepairAttempts !== undefined
        ? { outputRepairAttempts: meta.outputRepairAttempts }
        : {}),
      ...(meta.handoff !== undefined ? { delegatesTo: this.handoffEdges(meta) } : {}),
      ...(meta.personas !== undefined ? { personas: meta.personas } : {}),
      ...(meta.defaultPersona !== undefined ? { defaultPersona: meta.defaultPersona } : {}),
    };
  }

  /**
   * Refuse to boot on a persona declaration that could only fail later, per request: a default that
   * names no persona, an id declared twice, an alias two personas claim, or an alias that is a real
   * agent's name (which would never be reached — a registered agent always wins).
   */
  private assertPersonas(definitions: AgentDefinition[]): void {
    const agentNames = new Set(definitions.map((definition) => definition.name));
    const aliasOwner = new Map<string, string>();
    for (const definition of definitions) {
      const ids = new Set<string>();
      for (const persona of definition.personas ?? []) {
        if (ids.has(persona.id)) {
          throw new Error(`Agent "${definition.name}" declares persona "${persona.id}" twice.`);
        }
        ids.add(persona.id);
        for (const alias of persona.aliases ?? []) {
          const owner = `${definition.name}/${persona.id}`;
          if (agentNames.has(alias)) {
            throw new Error(
              `Persona ${owner} claims the alias "${alias}", which is a registered agent's name.`,
            );
          }
          const previous = aliasOwner.get(alias);
          if (previous !== undefined) {
            throw new Error(`Personas ${previous} and ${owner} both claim the alias "${alias}".`);
          }
          aliasOwner.set(alias, owner);
        }
      }
      if (definition.defaultPersona !== undefined && !ids.has(definition.defaultPersona)) {
        throw new Error(
          `Agent "${definition.name}" names "${definition.defaultPersona}" as its default persona, but declares no persona with that id.`,
        );
      }
    }
  }

  /**
   * Resolve each handoff entry to an {@link AgentDelegation} — its target's registered name, plus
   * whether that edge detaches (skipping non-agent classes). A bare name is kept for a plain edge
   * rather than an always-object form, so a definition an older host built by hand still reads.
   */
  private handoffEdges(meta: AgentOptions): AgentDelegation[] {
    const edges: AgentDelegation[] = [];
    for (const entry of meta.handoff ?? []) {
      const target = typeof entry === 'function' ? entry : entry.agent;
      const detached = typeof entry === 'function' ? false : entry.detached === true;
      const targetMeta = readAgentMetadata(target);
      if (targetMeta === undefined) {
        this.logger.warn(
          `Agent "${meta.name}" hands off to ${target.name}, which is not an @Agent — skipped.`,
        );
        continue;
      }
      edges.push(detached ? { agent: targetMeta.name, detached: true } : targetMeta.name);
    }
    return edges;
  }

  /** Push every `@SystemPromptContributor()` method on `instance` (bound) into the contributor list. */
  private collectContributors(instance: object): void {
    const prototype = Object.getPrototypeOf(instance) as object;
    for (const name of this.scanner.getAllMethodNames(prototype)) {
      if (Reflect.getMetadata(SYSTEM_PROMPT_CONTRIBUTOR_METADATA, prototype, name) === true) {
        const method = this.boundMethod(instance, name);
        if (method !== undefined) {
          this.contributors.push(
            (ctx: PromptContext) => method(ctx) as ReturnType<PromptContributor>,
          );
        }
      }
    }
  }

  /** The single method on `instance` carrying `metadataKey`, bound to the instance, or undefined. */
  private methodWith(
    instance: object,
    metadataKey: symbol,
  ): ((ctx: PromptContext) => unknown) | undefined {
    const prototype = Object.getPrototypeOf(instance) as object;
    for (const name of this.scanner.getAllMethodNames(prototype)) {
      if (Reflect.getMetadata(metadataKey, prototype, name) === true) {
        return this.boundMethod(instance, name);
      }
    }
    return undefined;
  }

  /** Bind a named method to its instance, guarding that it is actually a function. */
  private boundMethod(
    instance: object,
    name: string,
  ): ((ctx: PromptContext) => unknown) | undefined {
    const candidate = (instance as Record<string, unknown>)[name];
    if (typeof candidate !== 'function') {
      return undefined;
    }
    return (ctx: PromptContext) =>
      (candidate as (ctx: PromptContext) => unknown).call(instance, ctx);
  }
}
