import {
  AGENT_OPTIONS,
  AGENT_REGISTRY,
  AGENT_TOOL_REGISTRY,
  type AgentRegistry,
  type ToolHandler,
  type ToolRegistry,
} from '@dudousxd/nestjs-agent-core';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { z } from 'zod';
import { delegateToolName } from '../agent-deps.factory.js';
import type { AgentModuleOptions } from '../agent.options.js';
import { readAiToolMetadata } from '../decorator/ai-tool.decorator.js';
import { type FunctionalTool, isBrandedFunctionalTool } from '../functional-tool.js';

/** Walks every provider at boot and registers `@AiTool` classes into the shared registry. */
@Injectable()
export class AiToolDiscoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AiToolDiscoveryService.name);

  constructor(
    private readonly discovery: DiscoveryService,
    @Inject(AGENT_TOOL_REGISTRY) private readonly registry: ToolRegistry,
    @Inject(AGENT_REGISTRY) private readonly agents: AgentRegistry,
    @Inject(AGENT_OPTIONS) private readonly options: AgentModuleOptions,
  ) {}

  onApplicationBootstrap(): void {
    let count = 0;
    let functional = 0;
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance;
      if (instance === null || instance === undefined || typeof instance !== 'object') {
        continue;
      }
      // Functional tools registered via `provideAgentTool` resolve to a branded { spec, handler }.
      if (isBrandedFunctionalTool(instance)) {
        if (this.registerFunctionalTool(instance)) {
          functional += 1;
        }
        continue;
      }
      const meta = readAiToolMetadata(instance);
      if (meta === undefined) {
        continue;
      }
      const handler = instance as Partial<ToolHandler>;
      if (typeof handler.execute !== 'function') {
        this.logger.warn(`@AiTool "${meta.name}" has no execute() method — skipped`);
        continue;
      }
      this.registry.register(
        {
          name: meta.name,
          kind: meta.kind,
          description: meta.description,
          inputSchema: meta.input,
          // Leave roles unset when the tool didn't declare any — the RolesPolicy owns the default
          // (its `defaultRoles`). Baking it in here too would leak it into custom policies.
          ...(meta.roles !== undefined ? { roles: meta.roles } : {}),
          ...(meta.ability !== undefined ? { ability: meta.ability } : {}),
        },
        { execute: (input, ctx) => (instance as ToolHandler).execute(input, ctx) },
      );
      count += 1;
    }

    // Static functional tools passed straight to `forRoot({ tools })`.
    for (const tool of this.options.tools ?? []) {
      if (this.registerFunctionalTool(tool)) {
        functional += 1;
      }
    }

    // Synthesize an `agent`-kind delegate tool for each agent->agent edge declared via `delegatesTo`.
    let delegates = 0;
    for (const definition of this.agents.list()) {
      for (const target of definition.delegatesTo ?? []) {
        const targetDefinition = this.agents.get(target);
        // A dangling handoff target (a `@Agent({ handoff })` class that isn't itself an `@Agent`)
        // would otherwise synthesize a delegate to a phantom agent that resolves to an UNRESTRICTED
        // default agent at runtime — a privilege-escalation footgun. Fail the boot instead.
        if (targetDefinition === undefined) {
          throw new Error(
            `Agent "${definition.name}" hands off to "${target}", which is not a registered @Agent. Declare it as an @Agent provider or fix the reference.`,
          );
        }
        const name = delegateToolName(target);
        if (this.registry.has(name)) {
          continue;
        }
        // Only a flat string prompt is worth surfacing in the tool description; a PromptBuilder is
        // per-request and would stringify to source, so skip it.
        const targetBlurb =
          typeof targetDefinition.systemPrompt === 'string'
            ? ` It is: ${targetDefinition.systemPrompt}`
            : '';
        this.registry.register(
          {
            name,
            kind: 'agent',
            targetAgent: target,
            description: `Delegate a task to the "${target}" agent and get its answer.${targetBlurb}`,
            inputSchema: z.object({ task: z.string() }),
          },
          // Loop-handled (kind 'agent'); the handler is never called.
          { execute: async () => ({}) },
        );
        delegates += 1;
      }
    }
    this.logger.log(
      `registered ${count} AI tool(s), ${functional} functional tool(s) and ${delegates} delegate tool(s)`,
    );
  }

  /**
   * Registers a functional tool's `{ spec, handler }`, skipping it if a tool of the same name is
   * already registered. Returns whether it was newly registered.
   */
  private registerFunctionalTool(tool: FunctionalTool): boolean {
    if (this.registry.has(tool.spec.name)) {
      this.logger.warn(
        `functional tool "${tool.spec.name}" duplicates a registered name — skipped`,
      );
      return false;
    }
    this.registry.register(tool.spec, tool.handler);
    return true;
  }
}
