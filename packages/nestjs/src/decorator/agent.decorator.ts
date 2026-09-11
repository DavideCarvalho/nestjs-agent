import 'reflect-metadata';
import type { AgentHistoryWindow, AgentIntake } from '@dudousxd/nestjs-agent-core';
import type { Type } from '@nestjs/common';
import type { StandardSchemaV1 } from '@standard-schema/spec';

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
  /**
   * How deep delegation may nest below this agent before further hops are refused. Default 5.
   *
   * Not a budget for how MANY agents a turn delegates to — that is the model's, one tool call each,
   * and nothing caps it. This bounds the chain a `delegatesTo` cycle would otherwise run forever.
   */
  maxDelegationDepth?: number;
  /** Allow-list of global tool names this agent may use. Omit → every tool its role allows. */
  tools?: string[];
  /**
   * Other `@Agent` classes this agent may hand off to (auto-exposed as handoff tools). A bare class
   * is the delegation that has always existed: this agent's turn waits for the answer.
   *
   * `{ agent, detached: true }` is the other shape — the delegate is STARTED and this agent's turn
   * ends without its answer, which arrives in the conversation later as its own message. Declared
   * per edge, by the author, and never by the model: the same worker is worth waiting for in one
   * orchestrator and worth backgrounding in another, and only the person wiring the edge knows
   * which side of that the user is sitting on.
   */
  handoff?: (Type | { agent: Type; detached?: boolean })[];
  /**
   * How much of the thread this agent's turns carry, overriding `AgentModule.forRoot({ history })`.
   * `{ maxMessages }` and/or `{ maxTokens }` keep the newest that fit; `{ summarize: true }` folds
   * the rest into a leading summary, at one extra model call per run. Omit → the module-wide
   * ceiling, or none.
   */
  history?: AgentHistoryWindow;
  /**
   * Constrain this agent's final answer to a schema (any [Standard Schema](https://standardschema.dev)
   * — Zod, Valibot, ArkType). The turn calls its tools exactly as it would without one; the schema is
   * satisfied by one extra formatting call afterwards, so it works on providers that refuse a
   * response format and a tool set in the same request. The validated value comes back as `object`
   * on the run's result and is recorded on the assistant message as a `structured_output` tool call.
   *
   * Declared HERE rather than per request: a schema is a live object, and `AgentRunInput` crosses a
   * JSON boundary on its way into a durable workflow.
   */
  outputSchema?: StandardSchemaV1;
  /**
   * Extra model calls allowed to fix an answer that failed {@link outputSchema}, each shown the
   * previous attempt's validation issues. Omit → 1; `0` → fail on the first invalid reply with a
   * `StructuredOutputError`.
   */
  outputRepairAttempts?: number;
  /**
   * Questions this agent puts to the user BEFORE it starts working — the scope it needs, collected
   * up front rather than guessed. Authored here, so the turn spends no model call producing them
   * and a client knows the total ("Question 1 of 3") the moment the form appears. Every question
   * should pre-pick a default: the claim the surface makes is that confirming is enough.
   *
   * `when: 'thread-start'` (the default) asks once per thread; `'every-turn'` asks before each turn.
   * Omit → no intake.
   */
  intake?: AgentIntake;
  /**
   * Let the model ask its OWN clarifying question set, via the built-in `ask` tool, when it judges
   * the scope is missing. Overrides `AgentModule.forRoot({ ask })` for this agent. Omit → the
   * module-wide setting.
   */
  ask?: boolean;
}

export const AGENT_METADATA = Symbol.for('@dudousxd/nestjs-agent:agent-metadata');

/** Marks a provider class as an agent. See {@link AgentOptions}. */
export function Agent(options: AgentOptions): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(AGENT_METADATA, options, target);
  };
}

/**
 * Reads {@link AgentOptions} off a class (its constructor), or `undefined` if not an `@Agent`. The
 * reflection target is a class or Nest's provider `metatype`, whose type is precisely `Type |
 * Function`; narrowing it away from `Function` would reject valid callers.
 */
// biome-ignore lint/complexity/noBannedTypes: the reflection target's type is precisely `Type | Function`.
export function readAgentMetadata(target: Type | Function): AgentOptions | undefined {
  return Reflect.getMetadata(AGENT_METADATA, target) as AgentOptions | undefined;
}
