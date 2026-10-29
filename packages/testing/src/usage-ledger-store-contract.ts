import {
  type AgentGovernanceQueries,
  type AgentStore,
  PLATFORM_ACTOR_REF,
  type RunTimings,
} from '@dudousxd/nestjs-agent-core';

/**
 * A store under test: the agent store, the governance queries over the same data, and a thread rows
 * may hang off (`threadId`, created by the subject for `actorRef`).
 */
export interface UsageLedgerStoreContractSubject {
  store: AgentStore;
  governance: AgentGovernanceQueries;
  threadId: string;
  actorRef: string;
}

/** One behaviour every store must have for the usage ledger and run timings. `run` throws on a mismatch. */
export interface UsageLedgerStoreContractCase {
  name: string;
  run: (subject: UsageLedgerStoreContractSubject) => Promise<void>;
}

function check(condition: boolean, message: string, actual?: unknown): void {
  if (!condition) {
    throw new Error(actual === undefined ? message : `${message} (got ${JSON.stringify(actual)})`);
  }
}

const close = (left: number, right: number) => Math.abs(left - right) < 1e-9;

/** JSON with its object keys sorted — a JSON column (`jsonb`) may hand keys back in its own order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) =>
    current !== null && typeof current === 'object' && !Array.isArray(current)
      ? Object.fromEntries(
          Object.entries(current as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : current,
  );
}
const today = () => new Date().toISOString().slice(0, 10);
const range = () => ({ fromDay: today(), toDay: today() });
const noTokens = { inputTokens: 0, outputTokens: 0 };

const timings: RunTimings = {
  modelMs: 1800,
  toolsMs: 400,
  modelCalls: 2,
  toolCalls: 1,
  steps: [
    {
      step: 0,
      modelMs: 1000,
      tools: [{ toolCallId: 'call-1', toolName: 'lookup', ms: 400 }],
      toolsMs: 400,
    },
    { step: 1, modelMs: 800, tools: [], toolsMs: 0 },
  ],
};

/**
 * The usage ledger beyond agent turns (`AgentService.recordUsage`: rows with no thread, billed in
 * audio seconds or characters, labelled by feature, platform cost) and the run timings a completed
 * run persists. Every SQL store runs these on SQLite, Postgres and MySQL.
 */
export const USAGE_LEDGER_STORE_CONTRACT: readonly UsageLedgerStoreContractCase[] = [
  {
    name: 'records usage with no thread, in any unit, and reports it by feature and by actor × feature',
    async run({ store, governance, actorRef }) {
      await store.recordUsage({
        actorRef,
        modelId: 'whisper-1',
        purpose: 'external',
        feature: 'transcription',
        provider: 'openai',
        usage: noTokens,
        audioSeconds: 90.5,
        costUsd: 0.009,
        costSource: 'provider',
        tenantRef: 't1',
        metadata: { meetingId: 'm-1' },
      });
      await store.recordUsage({
        actorRef,
        modelId: 'text-embedding-3-small',
        purpose: 'external',
        feature: 'embeddings',
        usage: { inputTokens: 1200, outputTokens: 0 },
        requests: 3,
        costUsd: 0.00002,
        costSource: 'estimate',
      });
      await store.recordUsage({
        actorRef: PLATFORM_ACTOR_REF,
        modelId: 'tts-1',
        purpose: 'external',
        feature: 'tts',
        usage: noTokens,
        characters: 5000,
        costUsd: 0.075,
      });
      const features = (await governance.spendByFeature?.(range())) ?? [];
      check(
        JSON.stringify(features.map((row) => [row.feature, row.source])) ===
          JSON.stringify([
            ['tts', 'external'],
            ['transcription', 'external'],
            ['embeddings', 'external'],
          ]),
        'spendByFeature ranks the features costliest first',
        features,
      );
      const transcription = features.find((row) => row.feature === 'transcription');
      check(transcription?.audioSeconds === 90.5, 'audio seconds round-trip', transcription);
      check(transcription?.requests === 1, 'a row with no requests counts as one', transcription);
      check(
        features.find((row) => row.feature === 'embeddings')?.requests === 3,
        'a row counts its own requests',
      );
      check(
        features.find((row) => row.feature === 'tts')?.characters === 5000,
        'characters round-trip',
      );
      const breakdown = (await governance.usageBreakdown?.(range())) ?? [];
      check(
        breakdown.find((row) => row.feature === 'tts')?.actorRef === PLATFORM_ACTOR_REF,
        'platform cost is its own actor',
        breakdown,
      );
      const embeddings = breakdown.find((row) => row.feature === 'embeddings');
      check(
        embeddings !== undefined && close(embeddings.estimatedCostUsd, 0.00002),
        'an estimated cost is reported as one',
        embeddings,
      );
      check(
        ((await governance.usageBreakdown?.(range(), { actor: actorRef })) ?? []).length === 2,
        'usageBreakdown filters by actor',
      );
      check(
        ((await governance.usageBreakdown?.(range(), { feature: 'tts' })) ?? []).length === 1,
        'usageBreakdown filters by feature',
      );
    },
  },
  {
    name: 'labels a row with no feature `agent`, and keeps usage without a thread out of per-thread spend',
    async run({ store, governance, threadId, actorRef }) {
      await store.recordUsage({
        threadId,
        actorRef,
        modelId: 'gpt-4o-mini',
        purpose: 'chat',
        usage: { inputTokens: 10, outputTokens: 5 },
      });
      await store.recordUsage({
        actorRef,
        modelId: 'whisper-1',
        purpose: 'external',
        feature: 'transcription',
        usage: noTokens,
        audioSeconds: 12,
      });
      const features = (await governance.spendByFeature?.(range())) ?? [];
      check(
        features.some((row) => row.feature === 'agent' && row.source === 'agent'),
        'a row with no feature reads as `agent`',
        features,
      );
      const threads = await governance.spendByThread(range(), 10);
      check(
        threads.length === 1 && threads[0]?.threadId === threadId,
        'usage without a thread belongs to no thread',
        threads,
      );
    },
  },
  {
    name: 'counts a row’s own requests the same way in every rollup',
    async run({ store, governance, actorRef }) {
      await store.recordUsage({
        actorRef,
        modelId: 'text-embedding-3-small',
        purpose: 'external',
        feature: 'embeddings',
        usage: { inputTokens: 10, outputTokens: 0 },
        requests: 12,
      });
      const byModel = await governance.spendByModel(range());
      const byActor = await governance.spendByActor(range());
      const byFeature = (await governance.spendByFeature?.(range())) ?? [];
      check(byModel[0]?.requests === 12, 'spendByModel counts the row’s requests', byModel);
      check(byActor[0]?.requests === 12, 'spendByActor counts the row’s requests', byActor);
      check(byFeature[0]?.requests === 12, 'spendByFeature counts the row’s requests', byFeature);
    },
  },
  {
    name: 'counts tokens in the token windows and cost in the USD windows; audio adds no tokens',
    async run({ store, actorRef }) {
      await store.recordUsage({
        actorRef,
        modelId: 'whisper-1',
        purpose: 'external',
        feature: 'transcription',
        usage: noTokens,
        audioSeconds: 60,
        costUsd: 0.006,
      });
      await store.recordUsage({
        actorRef,
        modelId: 'gpt-4o-mini',
        purpose: 'external',
        feature: 'spellcheck',
        usage: { inputTokens: 100, outputTokens: 20 },
        costUsd: 0.0001,
      });
      const day = await store.quotaToday(actorRef, today());
      check(day.usedTokens === 120, 'the token window sums tokens only', day);
      check(close(day.costUsd, 0.0061), 'the USD window sums every priced row', day);
    },
  },
  {
    name: 'persists a run’s queue time at start and its timings on completion',
    async run({ store, governance, threadId, actorRef }) {
      if (store.recordRunStart === undefined || store.recordRunEnd === undefined) return;
      await store.recordRunStart({ runId: 'run-timed', threadId, actorRef, queueMs: 37 });
      await store.recordRunEnd({
        runId: 'run-timed',
        status: 'completed',
        durationMs: 2500,
        timings,
      });
      const detail = await governance.runDetail('run-timed');
      check(detail?.run.queueMs === 37, 'queueMs round-trips', detail?.run);
      check(detail?.run.modelMs === 1800, 'modelMs round-trips', detail?.run);
      check(detail?.run.toolsMs === 400, 'toolsMs round-trips', detail?.run);
      check(detail?.run.modelCalls === 2, 'modelCalls round-trips', detail?.run);
      check(detail?.run.toolCalls === 1, 'toolCalls round-trips', detail?.run);
      check(
        canonical(detail?.timings?.steps) === canonical(timings.steps),
        'the per-step breakdown round-trips',
        detail?.timings,
      );
      const [recent] = await governance.recentRuns(5);
      check(recent?.toolsMs === 400, 'the run list carries the totals', recent);
    },
  },
  {
    name: 'leaves the timings null for a run that did not complete, keeping its queue time',
    async run({ store, governance, threadId, actorRef }) {
      if (store.recordRunStart === undefined || store.recordRunEnd === undefined) return;
      await store.recordRunStart({ runId: 'run-failed', threadId, actorRef, queueMs: 5 });
      await store.recordRunEnd({ runId: 'run-failed', status: 'failed', errorCode: 'run_failed' });
      const detail = await governance.runDetail('run-failed');
      check(detail?.run.queueMs === 5, 'the queue time stays', detail?.run);
      check(detail?.run.modelMs === null, 'no model time', detail?.run);
      check((detail?.timings ?? null) === null, 'no timings', detail?.timings);
    },
  },
];
