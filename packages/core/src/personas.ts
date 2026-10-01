import type { AgentDefinition, Persona, PersonaCatalogEntry } from './types.js';

/**
 * The narrower of two tool allow-lists. `undefined` is "no restriction", so it yields the other;
 * two lists yield the names on both, in the order of the first.
 */
export function intersectAllowLists(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined,
): string[] | undefined {
  if (first === undefined) {
    return second === undefined ? undefined : [...second];
  }
  if (second === undefined) {
    return [...first];
  }
  const allowed = new Set(second);
  return first.filter((name) => allowed.has(name));
}

/** The persona `id` of `definition`, or `undefined` when it declares none by that id. */
export function findPersona(
  definition: Pick<AgentDefinition, 'personas'> | undefined,
  id: string | undefined,
): Persona | undefined {
  if (id === undefined) {
    return undefined;
  }
  return definition?.personas?.find((persona) => persona.id === id);
}

/** A persona as a picker reads it — never its prompt or its allow-list. */
export function personaCatalogEntry(persona: Persona): PersonaCatalogEntry {
  return {
    id: persona.id,
    label: persona.label,
    ...(persona.description !== undefined ? { description: persona.description } : {}),
  };
}

/** Where a former agent name now lives: an agent, and the persona of it the name stands for. */
export interface PersonaAlias {
  agent: string;
  persona: string;
}

/**
 * Resolve `name` through the {@link Persona.aliases} of `definitions`: the agent and persona that
 * answer for it, or `undefined` when no persona claims it. A name that IS a registered agent is
 * never an alias — the caller checks that first, so a real agent always wins.
 */
export function resolvePersonaAlias(
  definitions: readonly AgentDefinition[],
  name: string,
): PersonaAlias | undefined {
  for (const definition of definitions) {
    for (const persona of definition.personas ?? []) {
      if (persona.aliases?.includes(name) === true) {
        return { agent: definition.name, persona: persona.id };
      }
    }
  }
  return undefined;
}
