import 'reflect-metadata';
import type { Type } from '@nestjs/common';

/**
 * Declares a class as an agent. The class is discovered at boot (via `DiscoveryService`) and
 * registered into the `AgentRegistry` — its name, base prompt, tool allow-list, and handoff targets
 * become an internal `AgentDefinition` the loop consumes. The class is an ordinary provider, so it
 * gets constructor DI (its retriever, schema service, policy) — the reason an agent is a class and
 * not a config object.
 *
 * The base prompt is either the `systemPrompt` string here or, for a dynamic prompt, a
 * `@SystemPrompt()` method on the class (which may inject services and read the turn's
 * `PromptContext`). Tools are the global `@AiTool` providers named in `tools` (omit → all tools the
 * actor's role allows); handoff targets are other `@Agent` classes.
 */
export interface AgentOptions {
  /** Unique agent name — how a turn selects it and how a message records its provenance. */
  name: string;
  /** Human-readable summary (shown to an orchestrator that may hand off to this agent). */
  description?: string;
  /** A flat base prompt. For a dynamic prompt, add a `@SystemPrompt()` method instead. */
  systemPrompt?: string;
  /** Accounting label for the model this agent uses (the model provider itself is shared). */
  model?: string;
  /** Max model→tool iterations for this agent's turn. Default 8. */
  maxSteps?: number;
  /** Allow-list of global tool names this agent may use. Omit → every tool its role allows. */
  tools?: string[];
  /** Other `@Agent` classes this agent may hand off to (auto-exposed as handoff tools). */
  handoff?: Type[];
}

export const AGENT_METADATA = Symbol.for('@dudousxd/nestjs-agent:agent-metadata');

/** Marks a provider class as an agent. See {@link AgentOptions}. */
export function Agent(options: AgentOptions): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(AGENT_METADATA, options, target);
  };
}

/** Reads {@link AgentOptions} off a class (its constructor), or `undefined` if not an `@Agent`. */
export function readAgentMetadata(target: Type | Function): AgentOptions | undefined {
  return Reflect.getMetadata(AGENT_METADATA, target) as AgentOptions | undefined;
}
