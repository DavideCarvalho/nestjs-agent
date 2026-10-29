import { publishAgentUsageRecorded } from './diagnostics.js';
import {
  type AgentStore,
  type CostSource,
  PLATFORM_ACTOR_REF,
  type RecordUsageInput,
} from './spi/agent-store.js';
import type { QuotaStore } from './spi/quota-store.js';
import type { AgentRunInput } from './types.js';

/**
 * What an agent turn's usage rows say about themselves beyond tokens: the feature (`agent:<agent
 * name>`, or `agent` for a run that names none — what a cost-by-feature report groups agent spend
 * under) and the actor's tenant.
 */
export function usageAttribution(input: Pick<AgentRunInput, 'agentName' | 'actor'>): {
  feature: string;
  tenantRef?: string;
} {
  const tenantRef = input.actor.tenantRef;
  return {
    feature: input.agentName === undefined ? 'agent' : `agent:${input.agentName}`,
    ...(typeof tenantRef === 'string' ? { tenantRef } : {}),
  };
}

/**
 * Write one usage-ledger row and publish it as `aviary:agent:usage.recorded` — the single path every
 * AI cost takes (the loop's model calls and `AgentService.recordUsage`), so a subscriber sees all of
 * it through one event. The loop calls this INSIDE a step body: a durable replay skips the body, so a
 * row is neither written nor published twice. Published only once the write succeeded.
 */
export async function recordUsageRow(store: AgentStore, input: RecordUsageInput): Promise<void> {
  await store.recordUsage(input);
  publishAgentUsageRecorded({
    actorRef: input.actorRef,
    feature: input.feature ?? 'agent',
    purpose: input.purpose,
    modelId: input.modelId,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.usage.cacheReadTokens !== undefined
      ? { cacheReadTokens: input.usage.cacheReadTokens }
      : {}),
    ...(input.usage.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: input.usage.cacheWriteTokens }
      : {}),
    ...(input.audioSeconds !== undefined ? { audioSeconds: input.audioSeconds } : {}),
    ...(input.characters !== undefined ? { characters: input.characters } : {}),
    ...(input.requests !== undefined ? { requests: input.requests } : {}),
    ...(input.costUsd !== undefined
      ? { costUsd: input.costUsd, costSource: input.costSource ?? 'provider' }
      : {}),
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.tenantRef !== undefined ? { tenantRef: input.tenantRef } : {}),
  });
}

/**
 * AI spend recorded from outside an agent turn — see `AgentService.recordUsage`. Every unit is
 * optional: a row carries whatever the provider bills by and its cost when known.
 */
export interface AiUsageInput {
  /** Who pays. `null` → platform cost, recorded under {@link PLATFORM_ACTOR_REF}. */
  actorRef: string | null;
  /** What the spend was for, free-form: `'transcription'`, `'embeddings'`, `'spellcheck'`. */
  feature: string;
  modelId: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  audioSeconds?: number;
  characters?: number;
  requests?: number;
  /** The USD cost, when known. Absent → unpriced (governance prices its tokens, if any). */
  costUsd?: number;
  /** Where `costUsd` came from. Default `'provider'`. */
  costSource?: CostSource;
  threadId?: string;
  runId?: string;
  tenantRef?: string;
  metadata?: Record<string, unknown>;
}

/** How `AgentService.recordUsage` reacts to a failure. */
export interface AiUsageOptions {
  /** Rethrow a failed write (or an invalid input) instead of logging it. Default `false`. */
  throwOnError?: boolean;
}

/** What `AgentService.recordUsage` answers. */
export type AiUsageResult = { recorded: true } | { recorded: false; error: Error };

function amount(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`recordUsage: ${name} must be a non-negative number, got ${String(value)}`);
  }
  return value;
}

/** {@link AiUsageInput} as the store's ledger row, validated (a `TypeError` when it is not valid). */
export function aiUsageRow(input: AiUsageInput): RecordUsageInput {
  if (typeof input.feature !== 'string' || input.feature.trim() === '') {
    throw new TypeError('recordUsage: feature is required');
  }
  if (typeof input.modelId !== 'string' || input.modelId.trim() === '') {
    throw new TypeError('recordUsage: modelId is required');
  }
  if (
    input.actorRef !== null &&
    (typeof input.actorRef !== 'string' || input.actorRef.trim() === '')
  ) {
    throw new TypeError(
      'recordUsage: actorRef must be a non-empty string, or null for platform cost',
    );
  }
  if (
    input.costSource !== undefined &&
    input.costSource !== 'provider' &&
    input.costSource !== 'estimate'
  ) {
    throw new TypeError("recordUsage: costSource must be 'provider' or 'estimate'");
  }
  const whole = (name: string, value: number | undefined) => {
    const parsed = amount(name, value);
    return parsed === undefined ? undefined : Math.round(parsed);
  };
  const cacheRead = whole('cacheReadTokens', input.cacheReadTokens);
  const cacheWrite = whole('cacheWriteTokens', input.cacheWriteTokens);
  const audioSeconds = amount('audioSeconds', input.audioSeconds);
  const characters = whole('characters', input.characters);
  const requests = whole('requests', input.requests);
  // Absent means one billable request; zero would make the row count as none.
  if (requests !== undefined && requests < 1) {
    throw new TypeError(`recordUsage: requests must be at least 1, got ${String(input.requests)}`);
  }
  const costUsd = amount('costUsd', input.costUsd);
  return {
    actorRef: input.actorRef ?? PLATFORM_ACTOR_REF,
    feature: input.feature,
    modelId: input.modelId,
    purpose: 'external',
    usage: {
      inputTokens: whole('inputTokens', input.inputTokens) ?? 0,
      outputTokens: whole('outputTokens', input.outputTokens) ?? 0,
      ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    },
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(audioSeconds !== undefined ? { audioSeconds } : {}),
    ...(characters !== undefined ? { characters } : {}),
    ...(requests !== undefined ? { requests } : {}),
    ...(costUsd !== undefined ? { costUsd, costSource: input.costSource ?? 'provider' } : {}),
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.tenantRef !== undefined ? { tenantRef: input.tenantRef } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
}

/**
 * What `AgentService.recordUsage` does, framework-free: validate, write the ledger row (publishing
 * `usage.recorded`), bump the actor's tokens on the {@link QuotaStore} the loop gates on — never for
 * platform cost — and never throw unless `throwOnError`. `warn` receives what was not recorded.
 */
export async function recordAiUsage(args: {
  store: AgentStore;
  quota?: QuotaStore | undefined;
  day: string;
  input: AiUsageInput;
  options?: AiUsageOptions;
  warn: (message: string) => void;
}): Promise<AiUsageResult> {
  try {
    const row = aiUsageRow(args.input);
    await recordUsageRow(args.store, row);
    const tokens = row.usage.inputTokens + row.usage.outputTokens;
    if (args.quota !== undefined && row.actorRef !== PLATFORM_ACTOR_REF && tokens > 0) {
      await args.quota.bump(row.actorRef, args.day, tokens).catch((error: unknown) => {
        args.warn(
          `recordUsage: the row was written, the quota counter was not bumped: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
    return { recorded: true };
  } catch (failure) {
    const error = failure instanceof Error ? failure : new Error(String(failure));
    if (args.options?.throwOnError === true) throw error;
    args.warn(`recordUsage(${String(args.input.feature)}) was not recorded: ${error.message}`);
    return { recorded: false, error };
  }
}
