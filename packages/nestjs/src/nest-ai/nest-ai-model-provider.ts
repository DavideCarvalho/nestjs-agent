import { describeAiSdkModel, runAiSdkTurn } from '@dudousxd/nestjs-agent-ai-sdk';
import {
  type DescribedModel,
  type MessageUsage,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  type PriceCatalogEntry,
  type SinkWriter,
  staticModelCatalog,
} from '@dudousxd/nestjs-agent-core';
import type {
  AiCallSettings,
  AiModelDefinition,
  AiModelPricing,
  AiModels,
  AiModuleOptions,
  AiUsageEvent,
} from '@nestjs/ai';
import { Logger } from '@nestjs/common';
import {
  type AttemptContext,
  type Duration,
  FallbackPolicy,
  ResiliencePolicy as Policy,
  ResilienceError,
  type ResiliencePolicy,
  type ResilienceService,
  ResilienceTimeoutError,
  type RetryOptions,
  RetryPolicy,
  TimeoutPolicy,
} from '@nestjs/resilience';
import { APICallError, type LanguageModel, RetryError } from 'ai';
import { Observable } from 'rxjs';

const logger = new Logger('AgentModels');

/** `@nestjs/ai`'s defaults, kept in step with it: a model call's timeout and retry backoff. */
const DEFAULT_TIMEOUT: Duration = '60s';
const DEFAULT_BACKOFF = { delay: 1_000, factor: 2, maxDelay: 30_000 } as const;

/** `ai`'s argument errors: no retry and no other model fixes them. */
const CALLER_MISTAKES = new Set([
  'AI_InvalidPromptError',
  'AI_InvalidArgumentError',
  'AI_InvalidMessageRoleError',
  'AI_MessageConversionError',
]);

/** What {@link nestAiModelProvider} reads off `@nestjs/ai`. */
export interface NestAiModelProviderOptions {
  /** `AiModule`'s model registry: the names a turn picks from, and the `LanguageModel` behind each. */
  models: AiModels;
  /** `AiModule`'s options (`AI_MODULE_OPTIONS`): each model's settings, pricing and fallback, and `defaults`. */
  options: AiModuleOptions;
  /** Resolves a model's `resilience: 'preset'`. Required only when a model or `defaults` names one. */
  resilience?: ResilienceService;
  /** Names the agent's model calls in `onUsage` events. Default `'agent'`. */
  label?: string;
}

/** A {@link ModelProvider} over `@nestjs/ai`'s models, with the picker's catalog and their prices. */
export interface NestAiModelProvider extends ModelProvider {
  catalog: ModelCatalog;
  /** Price rows for the models `AiModule` prices (`pricing`), in its unit — read as USD per 1M tokens. */
  prices(): PriceCatalogEntry[];
}

interface ResolvedModel {
  name: string;
  model: LanguageModel;
  settings: AiCallSettings;
  pricing?: AiModelPricing;
  fallback: string[];
  provider: string;
  modelId: string;
}

/**
 * The agent's models are `@nestjs/ai`'s: a turn picks one of `AiModule.forRoot({ models })` by name
 * (the picker lists them all), and runs under what `AiModule` configures for it — its generation
 * settings, its `retry` and `timeout` (or its `resilience` policy or preset), its `fallback` models,
 * `onUsage`, and its `pricing` for cost.
 *
 * `@nestjs/ai`'s own calls offer the model only `@AgentFunction()` tools and run them themselves; the
 * agent's tools are governed, journaled and approved by the agent loop instead. So the turn itself is
 * one AI SDK call with the loop's tools offered and not run, put under the same policies `@nestjs/ai`
 * puts its calls under, with the same semantics: the timeout is the time to the first frame, and once
 * a frame has reached the reader nothing is retried and no other model takes over — the reader would
 * see the answer twice.
 */
export function nestAiModelProvider(config: NestAiModelProviderOptions): NestAiModelProvider {
  const { models, options } = config;
  const defaults = options.defaults ?? {};
  const names = models.names();
  if (names.length === 0) {
    throw new Error(
      'AgentModule: AiModule has no language models (`AiModule.forRoot({ models })`).',
    );
  }
  const defaultName = names.includes('default') ? 'default' : (names[0] as string);
  const resolved = new Map<string, ResolvedModel>();
  const policies = new Map<string, ResiliencePolicy | undefined>();

  const resolve = (name: string): ResolvedModel => {
    const known = resolved.get(name);
    if (known !== undefined) return known;
    if (!models.has(name)) {
      throw new Error(
        `AgentModule: this turn picked model "${name}", which AiModule does not configure (${names.join(', ')}).`,
      );
    }
    const model = models.get(name);
    const definition = definitionOf(options.models?.[name]);
    const described = describeAiSdkModel(model)[0];
    const entry: ResolvedModel = {
      name,
      model,
      settings: definition ?? {},
      ...(definition?.pricing !== undefined ? { pricing: definition.pricing } : {}),
      fallback: toList(definition?.fallback),
      provider: described?.provider ?? 'unknown',
      modelId: described?.modelId ?? name,
    };
    resolved.set(name, entry);
    return entry;
  };

  const policyFor = (model: ResolvedModel): ResiliencePolicy | undefined => {
    if (policies.has(model.name)) return policies.get(model.name);
    const own = model.settings.resilience ?? defaults.resilience;
    let policy: ResiliencePolicy | undefined;
    if (own === undefined) {
      policy = modelPolicy(model, {
        retry: model.settings.retry ?? defaults.retry,
        timeout: model.settings.timeout ?? defaults.timeout,
      });
    } else if (typeof own === 'string') {
      if (config.resilience === undefined) {
        throw new Error(
          `AgentModule: model "${model.name}" uses the resilience preset "${own}", but ResilienceModule is not imported.`,
        );
      }
      policy = config.resilience.preset(own);
    } else {
      policy = own;
    }
    policies.set(model.name, policy);
    return policy;
  };

  const settingsFor = (model: ResolvedModel) => {
    const pick = <K extends 'maxOutputTokens' | 'temperature' | 'providerOptions' | 'headers'>(
      key: K,
    ): AiCallSettings[K] => model.settings[key] ?? defaults[key];
    const settings: Record<string, unknown> = {
      // Retries are the policy's: the SDK's own would retry inside one attempt, behind its timeout.
      maxRetries: 0,
    };
    for (const key of ['maxOutputTokens', 'temperature', 'providerOptions', 'headers'] as const) {
      const value = pick(key);
      if (value !== undefined) settings[key] = value;
    }
    return settings;
  };

  const report = async (event: AiUsageEvent): Promise<void> => {
    if (options.onUsage === undefined) return;
    try {
      await options.onUsage(event);
    } catch (error) {
      logger.error(`AiModule's onUsage threw: ${String(error)}`);
    }
  };

  const groups = new Map<string, ModelCatalogEntry[]>();
  for (const name of names) {
    const { provider } = resolve(name);
    const list = groups.get(provider) ?? [];
    list.push({ id: name, label: name, available: true });
    groups.set(provider, list);
  }

  return {
    catalog: staticModelCatalog({
      default: defaultName,
      providers: [...groups].map(([id, list]) => ({
        id,
        label: id.charAt(0).toUpperCase() + id.slice(1),
        models: list,
      })),
    }),

    describeModels(): DescribedModel[] {
      const seen = new Set<string>();
      return names.flatMap((name) =>
        describeAiSdkModel(resolve(name).model).filter((described) => {
          if (seen.has(described.modelId)) return false;
          seen.add(described.modelId);
          return true;
        }),
      );
    },

    prices(): PriceCatalogEntry[] {
      return names.flatMap((name) => {
        const { pricing, modelId } = resolve(name);
        if (pricing === undefined) return [];
        return [
          {
            model: modelId,
            input: pricing.input,
            output: pricing.output,
            ...(pricing.cachedInput !== undefined ? { cacheRead: pricing.cachedInput } : {}),
          },
        ];
      });
    },

    async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
      const primary = resolve(args.model ?? defaultName);
      const chain = [primary, ...primary.fallback.map(resolve)].filter(
        (model, index, all) => all.findIndex((other) => other.model === model.model) === index,
      );
      const failures: unknown[] = [];

      const attemptsOf =
        (index: number) =>
        (context: AttemptContext): Observable<AttemptEvent> =>
          new Observable<AttemptEvent>((subscriber) => {
            const model = chain[index] as ResolvedModel;
            const started = Date.now();
            let committed = false;
            const signal =
              args.abortSignal !== undefined
                ? AbortSignal.any([args.abortSignal, context.signal])
                : context.signal;
            // The first frame that reaches the reader commits the attempt: from then on no retry,
            // timeout or fallback may replace it.
            const sink: SinkWriter = {
              write: (chunk) => {
                if (!committed) {
                  committed = true;
                  subscriber.next({ type: 'commit' });
                }
                return args.sink.write(chunk);
              },
              end: () => args.sink.end(),
              fail: (error) => args.sink.fail(error),
              ...(args.sink.flush !== undefined ? { flush: () => args.sink.flush?.() } : {}),
            };
            runAiSdkTurn(model.model, settingsFor(model), {
              ...args,
              sink,
              abortSignal: signal,
            }).then(
              ({ finishReason, ...turn }) => {
                subscriber.next({
                  type: 'outcome',
                  turn,
                  usage: {
                    label: config.label ?? 'agent',
                    model: { name: model.name, provider: model.provider, modelId: model.modelId },
                    step: 0,
                    attempt: context.attempt,
                    fallback: index > 0,
                    stream: true,
                    usage: toAiUsage(turn.usage),
                    ...withCost(turn.usage, model.pricing),
                    durationMs: Date.now() - started,
                    finishReason,
                  },
                });
                subscriber.complete();
              },
              (error: unknown) => {
                const reason = context.signal.aborted ? context.signal.reason : undefined;
                const failure = reason instanceof ResilienceTimeoutError ? reason : unwrap(error);
                failures.push(failure);
                subscriber.error(failure);
              },
            );
          });

      const policyAt = (index: number): ResiliencePolicy => {
        const model = chain[index] as ResolvedModel;
        const wrapped: ResiliencePolicy[] = [];
        if (index < chain.length - 1) {
          const next = chain[index + 1] as ResolvedModel;
          wrapped.push(
            new FallbackPolicy<AttemptEvent>(
              (error, context) => {
                logger.warn(
                  `The model "${model.name}" failed (${describeError(error)}); falling back to "${next.name}".`,
                );
                return policyAt(index + 1).executeObservable(attemptsOf(index + 1), {
                  signal: context.signal,
                  source: 'AgentModule',
                });
              },
              { name: `agent:${model.name} fallback`, handleIf: isFallbackable },
            ),
          );
        }
        const own = policyFor(model);
        if (own !== undefined) wrapped.push(own);
        return Policy.wrap(...wrapped);
      };

      const outcome = await new Promise<Extract<AttemptEvent, { type: 'outcome' }>>(
        (resolvePromise, reject) => {
          let settled: Extract<AttemptEvent, { type: 'outcome' }> | undefined;
          policyAt(0)
            .executeObservable(attemptsOf(0), {
              ...(args.abortSignal !== undefined ? { signal: args.abortSignal } : {}),
              source: 'AgentModule',
            })
            .subscribe({
              next: (event) => {
                if (event.type === 'outcome') settled = event;
              },
              error: (error: unknown) => reject(finalError(error, failures, args.abortSignal)),
              complete: () =>
                settled !== undefined
                  ? resolvePromise(settled)
                  : reject(new Error('The model call ended without an answer')),
            });
        },
      );
      await report(outcome.usage);
      return outcome.turn;
    },
  };
}

type AttemptEvent =
  | { type: 'commit' }
  | { type: 'outcome'; turn: ModelTurnResult; usage: AiUsageEvent };

/** A model's entry in `AiModule.forRoot({ models })`: a definition with settings, or a bare model. */
function definitionOf(value: unknown): AiModelDefinition | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  // A `LanguageModel` instance declares its spec version; a definition wraps one in `model`.
  if ('specificationVersion' in value || !('model' in value)) return undefined;
  return value as AiModelDefinition;
}

function toList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** `@nestjs/ai`'s model policy: retries (honoring the provider's `retry-after`) around a timeout. */
function modelPolicy(
  model: ResolvedModel,
  {
    retry,
    timeout,
  }: { retry: RetryOptions | false | undefined; timeout: Duration | false | undefined },
): ResiliencePolicy | undefined {
  const wrapped: ResiliencePolicy[] = [];
  if (retry !== false) {
    const own = retry ?? {};
    const custom = typeof own.backoff === 'function' ? own.backoff : undefined;
    const shape = typeof own.backoff === 'object' ? own.backoff : {};
    const maxDelay = toMs(shape.maxDelay ?? DEFAULT_BACKOFF.maxDelay);
    const delay = toMs(shape.delay ?? DEFAULT_BACKOFF.delay);
    const factor = Math.max(1, shape.factor ?? DEFAULT_BACKOFF.factor);
    const exponential = (attempt: number): number => {
      const computed = Math.min(maxDelay, delay * factor ** (attempt - 1));
      if (shape.jitter === 'none') return computed;
      if (shape.jitter === 'equal') return computed / 2 + Math.random() * (computed / 2);
      return Math.random() * computed;
    };
    const retryIf = own.retryIf ?? isRetryable;
    wrapped.push(
      new RetryPolicy({
        name: `agent:${model.name} retry`,
        attempts: own.attempts ?? 3,
        ...(own.retryOnResult !== undefined ? { retryOnResult: own.retryOnResult } : {}),
        // A provider asking for a longer wait than the backoff allows moves on to the fallback.
        retryIf: (error, attempt) =>
          (retryAfter(error) ?? 0) <= maxDelay && retryIf(error, attempt),
        backoff: custom ?? ((attempt, error) => retryAfter(error) ?? exponential(attempt)),
      }),
    );
  }
  if (timeout !== false) {
    wrapped.push(
      new TimeoutPolicy({
        timeout: timeout ?? DEFAULT_TIMEOUT,
        name: `agent:${model.name} timeout`,
      }),
    );
  }
  return wrapped.length > 0 ? Policy.wrap(...wrapped) : undefined;
}

/** Retried by default: what the provider marks retryable (429, 5xx, network), and timeouts. */
function isRetryable(error: unknown): boolean {
  if (error instanceof ResilienceTimeoutError) return true;
  return APICallError.isInstance(error) && error.isRetryable;
}

function isFallbackable(error: unknown): boolean {
  return !(error instanceof Error && CALLER_MISTAKES.has(error.name));
}

/** The caller's abort reason, a policy's own refusal, or the last model's failure. */
function finalError(error: unknown, failures: unknown[], signal: AbortSignal | undefined): unknown {
  if (signal?.aborted) return signal.reason;
  if (error instanceof ResilienceError && !(error instanceof ResilienceTimeoutError)) return error;
  return failures.at(-1) ?? error;
}

/** `ai` wraps errors it retried itself; the last one is what failed. */
function unwrap(error: unknown): unknown {
  return RetryError.isInstance(error) ? (error.lastError ?? error) : error;
}

/** The provider's `retry-after-ms` or `retry-after`, in milliseconds. */
function retryAfter(error: unknown): number | undefined {
  if (!APICallError.isInstance(error) || error.responseHeaders === undefined) return undefined;
  const headers = Object.fromEntries(
    Object.entries(error.responseHeaders).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const ms = Number.parseFloat(headers['retry-after-ms'] ?? '');
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const value = headers['retry-after'];
  if (value === undefined) return undefined;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** A `Duration` (`500`, `'30s'`) in milliseconds. */
function toMs(duration: Duration): number {
  if (typeof duration === 'number') return duration;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(duration);
  if (match === null) throw new Error(`Not a duration: ${duration}`);
  return Number(match[1]) * (UNITS[match[2] as string] as number);
}

function toAiUsage(usage: MessageUsage): AiUsageEvent['usage'] {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
    cachedInputTokens: usage.cacheReadTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
  };
}

/** The call's cost in the pricing's unit, as `@nestjs/ai` reports it; nothing without pricing. */
function withCost(usage: MessageUsage, pricing: AiModelPricing | undefined): { cost?: number } {
  if (pricing === undefined) return {};
  const cached = usage.cacheReadTokens ?? 0;
  const cost =
    ((usage.inputTokens - cached) * pricing.input +
      cached * (pricing.cachedInput ?? pricing.input) +
      usage.outputTokens * pricing.output) /
    1_000_000;
  return { cost };
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const { statusCode, status } = error as { statusCode?: unknown; status?: unknown };
  const code =
    typeof statusCode === 'number' ? statusCode : typeof status === 'number' ? status : undefined;
  return `${error.constructor.name}${code !== undefined ? `, ${code}` : ''}: ${error.message}`;
}
