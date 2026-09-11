import 'reflect-metadata';
import { GLOBAL_SCOPE, type SkillContext } from '@dudousxd/nestjs-agent-core';
import type { Type } from '@nestjs/common';

/**
 * Declares a provider class as a skill: an authored procedure any agent may pull in when a task
 * calls for it. Discovered at boot and offered to every turn whose scopes include its `scope`.
 *
 * NOT AN AGENT. An `@Agent` is who is answering — its model, its tools, its history ceiling. A skill
 * is how one task is done, and carries none of those: what it contributes is text, at a scope, under
 * a name the model can ask for. An instruction that should apply to EVERY turn of an agent is that
 * agent's `systemPrompt` (or a `@SystemPromptContributor()`), not a skill — a skill is for the ones
 * that should apply only when the work calls for them, which is what stops them costing a prompt.
 *
 * The class is an ordinary provider, so it gets constructor DI — the reason a skill is a class and
 * not a config entry. The body is either the flat `body` string here or a `body(ctx)` method on the
 * class (which may read the turn's {@link SkillContext} and inject services); implement
 * {@link SkillBody} to have the compiler hold you to its shape.
 */
export interface SkillOptions {
  /** Unique within its scope. What the model passes to the `skill` tool, and the `/` handle a UI offers. */
  name: string;
  /**
   * One line: what task this covers. Read by the MODEL to decide whether to load it, and by a person
   * choosing from an autocomplete — so write what it is FOR, not what it contains.
   */
  description: string;
  /**
   * The scope token this skill is published at. Omit → `'global'`, the deployment-wide default. Any
   * string a host's `ScopeResolver` can return works: `'tenant:berlin'`, `'sector:logistics'`.
   */
  scope?: string;
  /** A flat body. For one built per actor or per page, add a `body()` method instead. */
  body?: string;
}

/** The shape a `@Skill` class's body method takes. Implement it to be held to it at compile time. */
export interface SkillBody {
  body(ctx: SkillContext): string | Promise<string>;
}

export const SKILL_METADATA = Symbol.for('@dudousxd/nestjs-agent:skill-metadata');

/** Marks a provider class as a skill. See {@link SkillOptions}. */
export function Skill(options: SkillOptions): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(SKILL_METADATA, options, target);
  };
}

/** Reads {@link SkillOptions} off a class, or `undefined` if it is not a `@Skill`. */
// biome-ignore lint/complexity/noBannedTypes: the reflection target's type is precisely `Type | Function`.
export function readSkillMetadata(target: Type | Function): SkillOptions | undefined {
  return Reflect.getMetadata(SKILL_METADATA, target) as SkillOptions | undefined;
}

/** The scope a `@Skill` publishes at — its own, or the deployment-wide default. */
export function skillScope(options: SkillOptions): string {
  return options.scope ?? GLOBAL_SCOPE;
}
