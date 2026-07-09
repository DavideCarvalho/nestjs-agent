import 'reflect-metadata';

/**
 * Marks the method on an `@Agent` class that builds the agent's base system prompt. The method
 * receives the turn's `PromptContext` and returns a string (optionally async); because it lives on a
 * provider, it can inject services (e.g. describe a schema, read the actor). Exactly one per agent —
 * it takes precedence over the `@Agent({ systemPrompt })` string.
 */
export const SYSTEM_PROMPT_METADATA = Symbol.for('@dudousxd/nestjs-agent:system-prompt');

/**
 * Marks a method on any provider as a cross-agent system-prompt contributor: it returns an ordered
 * section appended to the composed prompt (after the selected agent's base), or `null` to contribute
 * nothing this turn. This is the seam an app uses to inject domain sections (base scope, a mentions
 * legend, schema hints) across every agent without forking the loop.
 */
export const SYSTEM_PROMPT_CONTRIBUTOR_METADATA = Symbol.for(
  '@dudousxd/nestjs-agent:system-prompt-contributor',
);

/** Marks an `@Agent` method as the agent's dynamic base prompt. See {@link SYSTEM_PROMPT_METADATA}. */
export function SystemPrompt(): MethodDecorator {
  return (target, key) => {
    Reflect.defineMetadata(SYSTEM_PROMPT_METADATA, true, target, key);
  };
}

/** Marks a provider method as a cross-agent prompt contributor. See {@link SYSTEM_PROMPT_CONTRIBUTOR_METADATA}. */
export function SystemPromptContributor(): MethodDecorator {
  return (target, key) => {
    Reflect.defineMetadata(SYSTEM_PROMPT_CONTRIBUTOR_METADATA, true, target, key);
  };
}
