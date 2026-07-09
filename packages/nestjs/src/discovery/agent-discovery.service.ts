import {
  AGENT_PROMPT_CONTRIBUTORS,
  AGENT_REGISTRY,
  type AgentDefinition,
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
      systemPrompt,
      ...(meta.tools !== undefined ? { tools: meta.tools } : {}),
      ...(meta.model !== undefined ? { modelId: meta.model } : {}),
      ...(meta.maxSteps !== undefined ? { maxSteps: meta.maxSteps } : {}),
      ...(meta.handoff !== undefined ? { delegatesTo: this.handoffNames(meta) } : {}),
    };
  }

  /** Resolve each handoff `@Agent` class to its registered name (skipping non-agent classes). */
  private handoffNames(meta: AgentOptions): string[] {
    const names: string[] = [];
    for (const target of meta.handoff ?? []) {
      const targetMeta = readAgentMetadata(target);
      if (targetMeta === undefined) {
        this.logger.warn(
          `Agent "${meta.name}" hands off to ${target.name}, which is not an @Agent — skipped.`,
        );
        continue;
      }
      names.push(targetMeta.name);
    }
    return names;
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
