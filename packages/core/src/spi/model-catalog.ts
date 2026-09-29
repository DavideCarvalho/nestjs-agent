import type { Actor } from '../types.js';
import type { ModelProvider, ModelTurnArgs } from './model-provider.js';

/** One model a caller may pick. */
export interface ModelCatalogEntry {
  /** What a client sends as `model` — and what the {@link ModelProvider} receives as `args.model`. */
  id: string;
  label: string;
  description?: string;
  /** Short tags a picker can render as chips — `'fast'`, `'reasoning'`, `'vision'`, `'new'`, … */
  badges?: string[];
  /** `false` → listed but not selectable right now (plan, quota, outage); a send naming it is refused. */
  available: boolean;
  /** Why it is unavailable, in words a picker can show. */
  unavailableReason?: string;
  /** Context window, in tokens, when the host knows it. */
  contextWindow?: number;
}

/** Models grouped under the provider that serves them. */
export interface ModelCatalogProviderGroup {
  id: string;
  label: string;
  models: ModelCatalogEntry[];
}

/** What `GET <base>/models` answers. */
export interface ModelCatalogView {
  providers: ModelCatalogProviderGroup[];
  /** The model a turn runs on when nobody picked one; `null` when the provider decides. */
  default: string | null;
}

export interface ModelCatalogQuery {
  actor: Actor;
  /** The agent the picker is for; omitted → the default agent. */
  agent?: string;
}

/**
 * Which models a caller may run a turn on — the picker's data and the send's gate. The server
 * refuses a `model` (on a send, or pinned on a thread) that this does not list as `available` for
 * the actor and agent, so a client cannot pick a model the host did not offer it.
 *
 * Bind with `AgentModule.forRoot({ models })`. Without one, `GET <base>/models` answers an empty
 * catalog and a request naming a model is refused.
 */
export interface ModelCatalog {
  list(query: ModelCatalogQuery): ModelCatalogView | Promise<ModelCatalogView>;
}

/** A catalog that answers the same view to everyone — for a fixed list of models. */
export function staticModelCatalog(view: ModelCatalogView): ModelCatalog {
  return { list: () => view };
}

/** The entry `id` names in `view`, or `undefined`. */
export function findCatalogModel(
  view: ModelCatalogView,
  id: string,
): ModelCatalogEntry | undefined {
  for (const group of view.providers) {
    const found = group.models.find((model) => model.id === id);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * A provider that runs every turn on `model` — what the loop wraps the bound provider in when a
 * turn has a selected model, so every call it makes (the answer, a structured-output pass, the
 * follow-up suggestions) goes to the same one. A provider that does not read `args.model` runs its
 * own default, unchanged.
 */
export function withSelectedModel(provider: ModelProvider, model: string): ModelProvider {
  return {
    runTurn: (args: ModelTurnArgs) => provider.runTurn({ ...args, model }),
  };
}
