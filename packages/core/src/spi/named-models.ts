import type { ModelCatalog } from './model-catalog.js';
import { staticModelCatalog } from './model-catalog.js';
import type {
  DescribedModel,
  ModelProvider,
  ModelTurnArgs,
  ModelTurnResult,
} from './model-provider.js';

export interface NamedModelsOptions {
  /** The model a turn runs on when nobody picked one. Omit → the first name. */
  default?: string;
  /** What a picker shows for each name. Omit → the name itself. */
  labels?: Record<string, string>;
}

/** A provider over several named providers, with the catalog that lists their names. */
export interface NamedModelsProvider extends ModelProvider {
  catalog: ModelCatalog;
  /** The configured names, the default first. */
  readonly names: readonly string[];
}

/**
 * One {@link ModelProvider} over several named ones — what `AgentModule.forRoot({ model: { fast, smart } })`
 * builds. A turn runs on the provider its model names (`args.model`), else on `default`. Each named
 * provider receives the turn without `model`: it serves one model and runs its own.
 */
export function namedModels(
  providers: Record<string, ModelProvider>,
  options: NamedModelsOptions = {},
): NamedModelsProvider {
  const names = Object.keys(providers);
  if (names.length === 0) throw new Error('namedModels: configure at least one model');
  const fallback = options.default ?? names[0];
  if (fallback === undefined || providers[fallback] === undefined) {
    throw new Error(
      `namedModels: the default model "${options.default}" is not one of the configured models (${names.join(', ')})`,
    );
  }
  const ordered = [fallback, ...names.filter((name) => name !== fallback)];
  return {
    names: ordered,
    catalog: staticModelCatalog({
      default: fallback,
      providers: [
        {
          id: 'models',
          label: 'Models',
          models: ordered.map((id) => ({ id, label: options.labels?.[id] ?? id, available: true })),
        },
      ],
    }),
    describeModels(): DescribedModel[] {
      return ordered.flatMap((name) => providers[name]?.describeModels?.() ?? []);
    },
    runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
      const name = args.model ?? fallback;
      const provider = providers[name];
      if (provider === undefined) {
        return Promise.reject(
          new Error(
            `namedModels: this turn picked model "${name}", which is not configured (${names.join(', ')})`,
          ),
        );
      }
      const { model: _picked, ...rest } = args;
      return provider.runTurn(rest);
    },
  };
}
