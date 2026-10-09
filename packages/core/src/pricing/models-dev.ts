import type { AgentPricingStore, ModelPriceInput } from '../spi/pricing-store.js';

/** The catalog's address. Open, keyless, one JSON document. */
export const MODELS_DEV_URL = 'https://models.dev/api.json';

/** The slice of the catalog read here. Everything else is ignored on purpose. */
interface ModelsDevCatalog {
  [provider: string]: {
    models?: {
      [model: string]: {
        cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
      };
    };
  };
}

export interface ModelsDevOptions {
  /** Override the catalog URL (an internal mirror). */
  url?: string;
  /** Alternate `fetch` — for tests, or a proxy. */
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

/** A model in the catalog: `'<provider>/<model>'`, e.g. `'openai/gpt-4o-mini'`. */
export type ModelsDevRef = string;

function parseRef(ref: ModelsDevRef): { provider: string; model: string } {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(
      `models.dev: "${ref}" is not "<provider>/<model>" (e.g. "openai/gpt-4o-mini"). The provider is required: the same model name is listed under several providers at different prices.`,
    );
  }
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

async function loadCatalog(options: ModelsDevOptions): Promise<ModelsDevCatalog> {
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('models.dev: no `fetch` available — pass `options.fetch`.');
  }
  const url = options.url ?? MODELS_DEV_URL;
  const response = await doFetch(url, options.signal ? { signal: options.signal } : {});
  if (!response.ok) throw new Error(`models.dev: ${url} answered ${response.status}`);
  return (await response.json()) as ModelsDevCatalog;
}

/** The price row a catalog entry yields, keyed by the model name — `undefined` when it has none. */
function priceOf(catalog: ModelsDevCatalog, ref: ModelsDevRef): ModelPriceInput | undefined {
  const { provider, model } = parseRef(ref);
  const cost = catalog[provider]?.models?.[model]?.cost;
  if (cost === undefined || typeof cost.input !== 'number' || typeof cost.output !== 'number') {
    return undefined;
  }
  return {
    modelId: model,
    inputPricePer1m: cost.input,
    outputPricePer1m: cost.output,
    ...(typeof cost.cache_write === 'number' ? { cacheWritePricePer1m: cost.cache_write } : {}),
    ...(typeof cost.cache_read === 'number' ? { cacheReadPricePer1m: cost.cache_read } : {}),
  };
}

/** The result of a lenient lookup: what the catalog priced, and what it did not. */
export interface ModelsDevLookup {
  prices: ModelPriceInput[];
  /** Refs with no entry, or an entry without an input/output price. */
  missing: ModelsDevRef[];
}

/**
 * Look prices up in [models.dev](https://models.dev). Lenient: a model the catalog does not price is
 * reported in `missing` rather than failing the batch. Throws only when the catalog cannot be read.
 * Each element is a LIST of candidate refs, tried in order — the first the catalog prices wins.
 * The rows are keyed by the MODEL name (`gpt-4o-mini`, `deepseek/deepseek-v4.1-flash`), the id the
 * provider is called with.
 */
export async function lookupModelsDevPrices(
  refs: readonly (readonly ModelsDevRef[])[],
  options: ModelsDevOptions = {},
): Promise<ModelsDevLookup> {
  if (refs.length === 0) return { prices: [], missing: [] };
  const catalog = await loadCatalog(options);
  const prices: ModelPriceInput[] = [];
  const missing: ModelsDevRef[] = [];
  for (const candidates of refs) {
    const price = candidates.map((ref) => priceOf(catalog, ref)).find((p) => p !== undefined);
    if (price !== undefined) prices.push(price);
    else if (candidates[0] !== undefined) missing.push(candidates[0]);
  }
  return { prices, missing };
}

/**
 * The models.dev refs to try for a model, most specific first: `<provider>/<modelId>`, then — for an
 * OpenRouter-style id (`deepseek/deepseek-v4.1-flash`) reached through another SDK — the OpenRouter
 * list price. `provider` is the AI SDK provider family (`openrouter`, `openai`, `vercel`, …).
 */
export function modelsDevRefsFor(modelId: string, provider: string | undefined): ModelsDevRef[] {
  const refs: ModelsDevRef[] = [];
  if (provider !== undefined && provider.length > 0) refs.push(`${provider}/${modelId}`);
  if (modelId.includes('/') && provider !== 'openrouter') refs.push(`openrouter/${modelId}`);
  return refs;
}

/**
 * Fetch the given models' prices from models.dev and write them to the store — the one-line seed for
 * an operator command. Strict: a model the catalog does not price throws, and nothing is written.
 */
export async function seedPricesFromModelsDev(
  store: AgentPricingStore,
  models: readonly ModelsDevRef[],
  options: ModelsDevOptions = {},
): Promise<ModelPriceInput[]> {
  const { prices, missing } = await lookupModelsDevPrices(
    models.map((ref) => [ref]),
    options,
  );
  if (missing.length > 0) {
    throw new Error(`models.dev: no input/output price for ${missing.join(', ')}.`);
  }
  for (const price of prices) await store.upsertModelPrice(price);
  return prices;
}
