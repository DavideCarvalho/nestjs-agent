import {
  type Actor,
  type ModelCatalog,
  type ModelCatalogView,
  findCatalogModel,
} from '@dudousxd/nestjs-agent-core';

/** A model an agent or persona names in its config (`@Agent({ model })`, `Persona.model`). */
export interface ConfiguredModel {
  model: string;
  agent: string;
  /** Set when the persona's own `model` named it. */
  persona?: string;
}

/** A model the catalog does not let this caller run a turn on. The HTTP layer answers it `400`. */
export class ModelNotAllowedError extends Error {
  override readonly name = 'ModelNotAllowedError';
}

/** Who configured a model, in words an error can show. */
export function describeConfigured(configured: ConfiguredModel): string {
  return configured.persona !== undefined
    ? `persona "${configured.persona}" of agent "${configured.agent}"`
    : `agent "${configured.agent}"`;
}

/** `model` if `view` offers it right now, else a {@link ModelNotAllowedError} naming why. */
export function assertCatalogModel(view: ModelCatalogView, model: string): string {
  const entry = findCatalogModel(view, model);
  if (entry === undefined) {
    throw new ModelNotAllowedError(`model "${model}" is not offered`);
  }
  if (!entry.available) {
    throw new ModelNotAllowedError(
      `model "${model}" is not available${entry.unavailableReason ? `: ${entry.unavailableReason}` : ''}`,
    );
  }
  return entry.id;
}

export interface ResolveTurnModelArgs {
  catalog: ModelCatalog | undefined;
  actor: Actor;
  agent: string;
  persona?: string;
  /** The send's own `model`. */
  requested?: string;
  /** The thread's pinned model, read only when nothing was requested. */
  pinned?: () => Promise<string | null | undefined>;
  /** The persona's `model`, then the agent's, most specific first. */
  configured?: readonly ConfiguredModel[];
  /** Called for a configured name the catalog does not list: it stays an accounting label. */
  onLabel?: (configured: ConfiguredModel) => void;
}

/**
 * The model a turn runs on, in precedence order: the catalog's lock, the send's own `model`, the
 * thread's pinned one, the persona's `model`, the agent's `model`, else `undefined` (the catalog's
 * default, or the provider's). Every pick goes through the catalog for this actor. A configured name
 * the catalog does not list is an accounting label (`onLabel`) and is skipped; one it lists but does
 * not offer this caller refuses the turn, naming the agent or persona.
 */
export async function resolveTurnModel(args: ResolveTurnModelArgs): Promise<string | undefined> {
  const { catalog, actor, agent, persona } = args;
  const configured = args.configured ?? [];
  if (catalog === undefined) {
    const picked =
      args.requested ?? (args.pinned !== undefined ? await args.pinned() : undefined) ?? undefined;
    if (picked !== undefined) {
      throw new ModelNotAllowedError(
        `model "${picked}" cannot be selected: no ModelCatalog is configured (AgentModule.forRoot({ models }))`,
      );
    }
    for (const entry of configured) args.onLabel?.(entry);
    return undefined;
  }
  const view = await catalog.list({ actor, agent, ...(persona !== undefined ? { persona } : {}) });
  const locked = view.locked;
  if (locked !== undefined) {
    if (args.requested !== undefined && args.requested !== locked.model) {
      throw new ModelNotAllowedError(
        `model "${args.requested}" cannot be selected: ${locked.reason ?? `this agent always uses "${locked.model}"`}`,
      );
    }
    return locked.model;
  }
  const picked =
    args.requested ?? (args.pinned !== undefined ? await args.pinned() : undefined) ?? undefined;
  if (picked !== undefined) {
    return assertCatalogModel(view, picked);
  }
  for (const entry of configured) {
    const listed = findCatalogModel(view, entry.model);
    if (listed === undefined) {
      args.onLabel?.(entry);
      continue;
    }
    if (!listed.available) {
      throw new ModelNotAllowedError(
        `${describeConfigured(entry)} runs on model "${entry.model}", which is not available to you${
          listed.unavailableReason ? `: ${listed.unavailableReason}` : ''
        }`,
      );
    }
    return listed.id;
  }
  return undefined;
}
