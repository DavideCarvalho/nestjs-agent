import type {
  ActorSpendRow,
  GenuiDayRow,
  GenuiStats,
  GovernancePage,
  ModelPrice,
  ModelSpendRow,
  PendingApprovalRow,
  RecentRunRow,
  ReliabilityOverview,
  RunDetail,
  RunTrendPoint,
  SpendOverview,
  ThreadActivityRow,
  ThreadDetail,
  ThreadSpendRow,
  ToolCallActivityRow,
  ToolStatRow,
  UsageTrendPoint,
} from '../client/agent-client';
import type { BudgetMap } from '../client/budget-usage';
import type { FeedEvent } from '../client/merge-live-events';

/** Deterministic mock data for the standalone preview entry (no backend). */

const MODELS: ModelSpendRow[] = [
  {
    modelId: 'gpt-4o',
    requests: 4200,
    inputTokens: 8_400_000,
    outputTokens: 2_100_000,
    costUsd: 84.2,
  },
  {
    modelId: 'claude-3-5-sonnet',
    requests: 2600,
    inputTokens: 5_200_000,
    outputTokens: 1_300_000,
    costUsd: 41.6,
  },
  {
    modelId: 'gpt-4o-mini',
    requests: 9800,
    inputTokens: 12_000_000,
    outputTokens: 3_000_000,
    costUsd: 9.4,
  },
  {
    modelId: 'llama-3-70b',
    requests: 1200,
    inputTokens: 2_100_000,
    outputTokens: 640_000,
    costUsd: 0,
  },
];

const ACTORS: ActorSpendRow[] = [
  {
    actorRef: 'tenant:acme',
    requests: 8200,
    totalTokens: 18_400_000,
    costUsd: 78.1,
    actorLabel: 'Acme Corp',
  },
  {
    actorRef: 'user:davi@goflip.ai',
    requests: 3100,
    totalTokens: 6_900_000,
    costUsd: 34.2,
    actorLabel: 'Davi de Carvalho',
  },
  {
    actorRef: 'tenant:globex',
    requests: 4400,
    totalTokens: 9_200_000,
    costUsd: 21.8,
    actorLabel: null,
  },
  {
    actorRef: 'user:ops-bot',
    requests: 2100,
    totalTokens: 3_940_000,
    costUsd: 1.1,
    actorLabel: null,
  },
];

const BUDGETS: BudgetMap = {
  'tenant:acme': 20_000_000,
  'user:davi@goflip.ai': 5_000_000,
  'tenant:globex': 12_000_000,
};

function buildTrend(): UsageTrendPoint[] {
  const points: UsageTrendPoint[] = [];
  for (let i = 29; i >= 0; i -= 1) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const wave = Math.sin(i / 3) * 0.5 + 1;
    points.push({
      day,
      totalTokens: Math.round(700_000 * wave + i * 4000),
      costUsd: Number((4.2 * wave + i * 0.05).toFixed(2)),
    });
  }
  return points;
}

function buildRunTrend(): RunTrendPoint[] {
  const points: RunTrendPoint[] = [];
  for (let i = 29; i >= 0; i -= 1) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const wave = Math.sin(i / 3) * 0.5 + 1;
    const runs = Math.round(18 * wave + i * 0.3);
    points.push({ day, runs, failed: Math.max(0, Math.round(runs * 0.06)) });
  }
  return points;
}

export const MOCK_SPEND: SpendOverview = {
  byModel: MODELS,
  byActor: ACTORS,
  trend: buildTrend(),
};

export const MOCK_RELIABILITY: ReliabilityOverview = {
  metrics: {
    runs: 482,
    completed: 461,
    failed: 21,
    successRate: 461 / 482,
    retries: 34,
    durationP50Ms: 640,
    durationP95Ms: 2_400,
  },
  byAgent: [
    { agentName: 'analyst', runs: 210, failed: 8, retries: 14 },
    { agentName: 'billing-agent', runs: 150, failed: 9, retries: 12 },
    { agentName: '(default)', runs: 122, failed: 4, retries: 8 },
  ],
  errors: [
    { errorCode: 'TIMEOUT', count: 9 },
    { errorCode: 'TOOL_ERROR', count: 6 },
    { errorCode: 'RATE_LIMIT', count: 4 },
    { errorCode: 'UNKNOWN', count: 2 },
  ],
  trend: buildRunTrend(),
};

/** The failed run every drill-down example opens — named so the detail fixture can't drift from the row. */
const FAILED_RUN: RecentRunRow = {
  runId: 'r-7c31',
  threadId: 'th2',
  actorRef: 'user:ops-bot',
  agentName: 'billing-agent',
  status: 'failed',
  durationMs: 4_200,
  errorCode: 'TIMEOUT',
  errorMessage: 'upstream model request timed out after 3 attempts',
  retries: 2,
  startedAt: new Date(Date.now() - 210_000).toISOString(),
  promptHash: 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221',
  parentRunId: null,
};

export const MOCK_RUNS: RecentRunRow[] = [
  {
    runId: 'r-9f2a',
    threadId: 'th1',
    actorRef: 'tenant:acme',
    agentName: 'analyst',
    status: 'completed',
    durationMs: 820,
    errorCode: null,
    errorMessage: null,
    retries: 0,
    startedAt: new Date(Date.now() - 40_000).toISOString(),
    promptHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678901234567890abcdef01234',
    parentRunId: null,
  },
  FAILED_RUN,
  {
    runId: 'r-a114',
    threadId: 'th3',
    actorRef: 'user:davi@goflip.ai',
    agentName: null,
    status: 'completed',
    durationMs: 1_150,
    errorCode: null,
    errorMessage: null,
    retries: 1,
    startedAt: new Date(Date.now() - 540_000).toISOString(),
    promptHash: null,
    parentRunId: null,
  },
  {
    runId: 'r-b902',
    threadId: 'th1',
    actorRef: 'tenant:acme',
    agentName: 'analyst',
    status: 'failed',
    durationMs: 980,
    errorCode: 'TOOL_ERROR',
    errorMessage: 'search_records returned a 500',
    retries: 0,
    startedAt: new Date(Date.now() - 1_320_000).toISOString(),
    promptHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678901234567890abcdef01234',
    parentRunId: null,
  },
  {
    runId: 'r-c447',
    threadId: 'th2',
    actorRef: 'user:ops-bot',
    agentName: 'billing-agent',
    status: 'running',
    durationMs: null,
    errorCode: null,
    errorMessage: null,
    retries: 0,
    startedAt: new Date(Date.now() - 8_000).toISOString(),
    promptHash: 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221',
    // Still running after the turn that started it settled: the detached case.
    parentRunId: 'r-7c31',
  },
];

export const MOCK_PENDING_APPROVALS: PendingApprovalRow[] = [
  {
    toolCallId: 'tc-approve-1',
    runId: 'r-c447',
    toolName: 'delete_asset',
    input: { assetId: 'asset-42', reason: 'stale' },
    threadId: 'th2',
    threadTitle: 'Incident triage',
    actorRef: 'user:ops-bot',
    agentName: 'billing-agent',
    requestedAt: new Date(Date.now() - 300_000).toISOString(),
  },
  {
    toolCallId: 'tc-approve-2',
    runId: 'r-9f2a',
    toolName: 'send_email',
    input: { to: 'finance@acme.example', subject: 'Q3 invoice adjustment' },
    threadId: 'th1',
    threadTitle: 'Q3 procurement review',
    actorRef: 'tenant:acme',
    agentName: 'analyst',
    requestedAt: new Date(Date.now() - 900_000).toISOString(),
  },
];

export const MOCK_TOOL_STATS: ToolStatRow[] = [
  {
    toolName: 'search_records',
    toolType: 'read',
    calls: 420,
    failed: 6,
    rejected: 0,
    p50ExecutionMs: 42,
    p95ExecutionMs: 180,
  },
  {
    toolName: 'delete_asset',
    toolType: 'action',
    calls: 34,
    failed: 1,
    rejected: 4,
    p50ExecutionMs: 310,
    p95ExecutionMs: 620,
  },
  {
    toolName: 'send_email',
    toolType: 'action',
    calls: 58,
    failed: 2,
    rejected: 2,
    p50ExecutionMs: 96,
    p95ExecutionMs: 410,
  },
  {
    toolName: 'fetch_pricing',
    toolType: 'read',
    calls: 210,
    failed: 0,
    rejected: 0,
    p50ExecutionMs: 88,
    p95ExecutionMs: 95,
  },
];

export const MOCK_BUDGETS = BUDGETS;

export const MOCK_TOOL_CALLS: ToolCallActivityRow[] = [
  {
    toolCallId: 'tc1',
    runId: 'r-9f2a',
    toolName: 'search_records',
    toolType: 'read',
    status: 'ok',
    threadId: 'th1',
    createdAt: new Date(Date.now() - 12_000).toISOString(),
  },
  {
    toolCallId: 'tc2',
    runId: 'r-7c31',
    toolName: 'delete_asset',
    toolType: 'action',
    status: 'forbidden',
    threadId: 'th2',
    createdAt: new Date(Date.now() - 90_000).toISOString(),
  },
  {
    toolCallId: 'tc3',
    runId: 'r-9f2a',
    toolName: 'fetch_pricing',
    toolType: 'read',
    status: 'ok',
    threadId: 'th1',
    createdAt: new Date(Date.now() - 240_000).toISOString(),
  },
  {
    toolCallId: 'tc4',
    runId: 'r-a114',
    toolName: 'send_email',
    toolType: 'action',
    status: 'failed',
    threadId: 'th3',
    createdAt: new Date(Date.now() - 620_000).toISOString(),
  },
  {
    toolCallId: 'tc5',
    runId: null,
    toolName: 'summarize_thread',
    toolType: 'read',
    status: 'ok',
    threadId: 'th2',
    createdAt: new Date(Date.now() - 1_200_000).toISOString(),
  },
];

/** The thread the drill-down example opens — see {@link FAILED_RUN}. */
const INCIDENT_THREAD: ThreadActivityRow = {
  threadId: 'th2',
  title: 'Incident triage',
  actorRef: 'user:ops-bot',
  messageCount: 11,
  totalTokens: 62_000,
  lastActivityAt: new Date(Date.now() - 400_000).toISOString(),
  actorLabel: null,
};

export const MOCK_THREADS: ThreadActivityRow[] = [
  {
    threadId: 'th1',
    title: 'Q3 procurement review',
    actorRef: 'tenant:acme',
    messageCount: 24,
    totalTokens: 184_000,
    lastActivityAt: new Date(Date.now() - 30_000).toISOString(),
    actorLabel: 'Acme Corp',
  },
  INCIDENT_THREAD,
  {
    threadId: 'th3',
    title: 'Contract summary',
    actorRef: 'user:davi@goflip.ai',
    messageCount: 6,
    totalTokens: 28_400,
    lastActivityAt: new Date(Date.now() - 1_800_000).toISOString(),
    actorLabel: 'Davi de Carvalho',
  },
];

export const MOCK_TOP_THREADS: ThreadSpendRow[] = [
  {
    threadId: 'th1',
    title: 'Q3 procurement review',
    actorRef: 'tenant:acme',
    requests: 24,
    totalTokens: 184_000,
    costUsd: 18.4,
    actorLabel: 'Acme Corp',
  },
  {
    threadId: 'th2',
    title: 'Incident triage',
    actorRef: 'user:ops-bot',
    requests: 11,
    totalTokens: 62_000,
    costUsd: 6.2,
    actorLabel: null,
  },
  {
    threadId: 'th3',
    title: 'Contract summary',
    actorRef: 'user:davi@goflip.ai',
    requests: 6,
    totalTokens: 28_400,
    costUsd: 2.8,
    actorLabel: 'Davi de Carvalho',
  },
];

/** Page 1 (of several — `total` exceeds `rows.length`) of the paged tool-calls table for the preview. */
export const MOCK_TOOL_CALLS_PAGE: GovernancePage<ToolCallActivityRow> = {
  rows: MOCK_TOOL_CALLS,
  total: 137,
  page: 1,
  pageSize: 25,
};

/** Page 1 (of several) of the paged threads table for the preview. */
export const MOCK_THREADS_PAGE: GovernancePage<ThreadActivityRow> = {
  rows: MOCK_THREADS,
  total: 46,
  page: 1,
  pageSize: 25,
};

/** Page 1 (of several) of the paged recent-runs table for the preview. */
export const MOCK_RUNS_PAGE: GovernancePage<RecentRunRow> = {
  rows: MOCK_RUNS,
  total: 482,
  page: 1,
  pageSize: 25,
};

/**
 * Page 1 of the paged approvals inbox. `total` deliberately exceeds `rows.length` so the preview
 * shows the "N of M" line the unpaged inbox could never say.
 */
export const MOCK_APPROVALS_PAGE: GovernancePage<PendingApprovalRow> = {
  rows: MOCK_PENDING_APPROVALS,
  total: 7,
  page: 1,
  pageSize: 25,
};

/** A failed run's drill-down — the case the console had no way to open. */
export const MOCK_RUN_DETAIL: RunDetail = {
  run: FAILED_RUN,
  thread: {
    threadId: 'th2',
    title: 'Incident triage',
    actorRef: 'user:ops-bot',
    deleted: false,
    actorLabel: null,
  },
  toolCalls: [
    {
      toolCallId: 'tc2',
      toolName: 'delete_asset',
      toolType: 'action',
      status: 'forbidden',
      executionMs: null,
      executedByRef: 'user:davi@goflip.ai',
      error: null,
      createdAt: new Date(Date.now() - 215_000).toISOString(),
    },
    {
      toolCallId: 'tc9',
      toolName: 'fetch_pricing',
      toolType: 'read',
      status: 'ok',
      executionMs: 96,
      executedByRef: null,
      error: null,
      createdAt: new Date(Date.now() - 213_000).toISOString(),
    },
    {
      toolCallId: 'tc10',
      toolName: 'search_records',
      toolType: 'read',
      status: 'failed',
      executionMs: 3_980,
      executedByRef: null,
      error: 'upstream returned 500 after 3 attempts',
      createdAt: new Date(Date.now() - 212_000).toISOString(),
    },
  ],
};

/** A thread drill-down whose `runTotal` exceeds the returned `runs` — the "see all runs" path. */
export const MOCK_THREAD_DETAIL: ThreadDetail = {
  thread: INCIDENT_THREAD,
  deleted: false,
  usage: {
    requests: 11,
    inputTokens: 48_000,
    outputTokens: 14_000,
    totalTokens: 62_000,
    costUsd: 6.2,
  },
  runs: MOCK_RUNS.filter((run) => run.threadId === 'th2'),
  runTotal: 34,
  messages: [
    {
      messageId: 'm1',
      role: 'user',
      content: 'The billing sync failed again overnight — can you find out which asset broke it?',
      truncated: false,
      agentName: null,
      toolCallCount: 0,
      createdAt: new Date(Date.now() - 400_000).toISOString(),
    },
    {
      messageId: 'm2',
      role: 'assistant',
      content:
        'I found 3 assets with a null billing code. Asset-42 is the only one touched by last night’s sync, so I want to delete it — that needs your approval.',
      truncated: false,
      agentName: 'billing-agent',
      toolCallCount: 2,
      createdAt: new Date(Date.now() - 380_000).toISOString(),
    },
    {
      messageId: 'm3',
      role: 'assistant',
      content:
        'Here is the full audit trail for asset-42 across the last 90 days, starting with the ingest that first assigned it a billing code and continuing through every subsequent',
      truncated: true,
      agentName: 'billing-agent',
      toolCallCount: 1,
      createdAt: new Date(Date.now() - 360_000).toISOString(),
    },
  ],
};

export const MOCK_PRICES: ModelPrice[] = [
  {
    modelId: 'gpt-4o',
    inputPricePer1m: 2.5,
    outputPricePer1m: 10,
    cacheReadPricePer1m: 1.25,
    effectiveFrom: new Date(Date.now() - 5 * 86_400_000).toISOString(),
  },
  {
    modelId: 'claude-3-5-sonnet',
    inputPricePer1m: 3,
    outputPricePer1m: 15,
    cacheWritePricePer1m: 3.75,
    cacheReadPricePer1m: 0.3,
    effectiveFrom: new Date(Date.now() - 12 * 86_400_000).toISOString(),
  },
  {
    modelId: 'gpt-4o-mini',
    inputPricePer1m: 0.15,
    outputPricePer1m: 0.6,
    effectiveFrom: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  },
];

export const MOCK_LIVE_EVENTS: FeedEvent[] = [
  {
    id: 'e1',
    event: 'run.started',
    ts: Date.now() - 2000,
    payload: { runId: 'r-9f2', agentName: 'analyst' },
  },
  {
    id: 'e2',
    event: 'tool-call',
    ts: Date.now() - 5000,
    payload: { toolName: 'search_records', toolType: 'read', status: 'ok' },
  },
  {
    id: 'e3',
    event: 'quota.exceeded',
    ts: Date.now() - 9000,
    payload: { actorId: 'tenant:globex', usedTokens: 12_400_000, limitTokens: 12_000_000 },
  },
  {
    id: 'e4',
    event: 'tool-call',
    ts: Date.now() - 14_000,
    payload: { toolName: 'delete_asset', toolType: 'action', status: 'forbidden' },
  },
  {
    id: 'e5',
    event: 'delegated',
    ts: Date.now() - 20_000,
    payload: { fromAgent: 'router', toAgent: 'billing-agent' },
  },
  {
    id: 'e6',
    event: 'run.finished',
    ts: Date.now() - 26_000,
    payload: { runId: 'r-8a1', steps: 7, inputTokens: 4200, outputTokens: 1100 },
  },
];

function buildGenuiDays(): GenuiDayRow[] {
  const days: GenuiDayRow[] = [];
  for (let i = 29; i >= 0; i -= 1) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const wave = Math.sin(i / 4) * 0.4 + 1;
    const turns = Math.round(26 * wave + (29 - i) * 0.6);
    const calls = Math.round(turns * 1.28);
    days.push({
      day,
      calls,
      turns,
      inputTokens: calls * 3_400,
      outputTokens: calls * 1_150,
      costUsd: Number((calls * 0.0123).toFixed(4)),
      firstTryRate: Number((0.82 + Math.cos(i / 5) * 0.06).toFixed(3)),
    });
  }
  return days;
}

const GENUI_DAYS = buildGenuiDays();

/** Generative-UI telemetry for the preview: four tools across two models, a handful of error kinds. */
export const MOCK_GENUI_STATS: GenuiStats = {
  totals: {
    calls: GENUI_DAYS.reduce((sum, day) => sum + day.calls, 0),
    turns: GENUI_DAYS.reduce((sum, day) => sum + day.turns, 0),
    firstAttempts: 1_014,
    firstTrySuccesses: 842,
    firstTryRate: 842 / 1_014,
    retried: 131,
    failed: 207,
    inputTokens: GENUI_DAYS.reduce((sum, day) => sum + day.inputTokens, 0),
    outputTokens: GENUI_DAYS.reduce((sum, day) => sum + day.outputTokens, 0),
    costUsd: GENUI_DAYS.reduce((sum, day) => sum + (day.costUsd ?? 0), 0),
  },
  byToolModel: [
    {
      toolName: 'ui__render',
      modelId:
        'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5',
      mode: 'tree',
      calls: 612,
      firstAttempts: 498,
      firstTrySuccesses: 461,
      firstTryRate: 461 / 498,
      retried: 41,
      failed: 58,
      costUsd: 6.84,
    },
    {
      toolName: 'ui__sandbox',
      modelId:
        'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5',
      mode: 'sandbox',
      calls: 284,
      firstAttempts: 201,
      firstTrySuccesses: 139,
      firstTryRate: 139 / 201,
      retried: 52,
      failed: 93,
      costUsd: 5.12,
    },
    {
      toolName: 'ui__show_order_card',
      modelId: 'gpt-4o-mini',
      mode: 'per-component',
      calls: 241,
      firstAttempts: 232,
      firstTrySuccesses: 221,
      firstTryRate: 221 / 232,
      retried: 7,
      failed: 13,
      costUsd: 0.41,
    },
    {
      toolName: 'ui__show',
      modelId: 'gpt-4o-mini',
      mode: 'show',
      calls: 108,
      firstAttempts: 83,
      firstTrySuccesses: 21,
      firstTryRate: 21 / 83,
      retried: 31,
      failed: 43,
      costUsd: null,
    },
  ],
  errors: [
    {
      category: 'syntax',
      message:
        'invalid Sandbox code: jsx line 14:22: Unexpected token — check that every JSX tag is closed in order',
      toolName: 'ui__sandbox',
      count: 48,
      lastAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    },
    {
      category: 'shape',
      message: 'invalid UI tree: children[2].props.columns: Expected array, received "…"',
      toolName: 'ui__render',
      count: 37,
      lastAt: new Date(Date.now() - 40 * 60_000).toISOString(),
    },
    {
      category: 'unknown-component',
      message:
        'invalid UI tree code: children[0] jsx line 3:22: `<Slider>` is not a kit component — use one of `Button`, `Card`, or a plain element',
      toolName: 'ui__render',
      count: 21,
      lastAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    },
    {
      category: 'missing-app',
      message:
        'invalid Sandbox code: jsx: no `App` — rename `function Calculator` to `function App`; App is what gets drawn',
      toolName: 'ui__sandbox',
      count: 19,
      lastAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
    },
    {
      category: 'unavailable',
      message: 'component "…" is not available here',
      toolName: 'ui__show',
      count: 14,
      lastAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
    },
    {
      category: 'bridge',
      message:
        'invalid Sandbox code: html line 1:18: `flippy.send` — the bridge is `agent.send(payload)`',
      toolName: 'ui__sandbox',
      count: 9,
      lastAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    },
    {
      category: 'other',
      message: 'Request timed out after 30000ms',
      toolName: 'ui__show',
      count: 3,
      lastAt: new Date(Date.now() - 4 * 86_400_000).toISOString(),
    },
  ],
  byDay: GENUI_DAYS,
  costPerTurn: {
    turns: GENUI_DAYS.reduce((sum, day) => sum + day.turns, 0),
    avgUsd: 0.0157,
    p50Usd: 0.0112,
    p95Usd: 0.0441,
  },
  latency: {
    firstFrame: { samples: 1_002, p50Ms: 740, p95Ms: 2_310 },
    complete: { samples: 931, p50Ms: 3_480, p95Ms: 9_120 },
  },
};

/** What a store that records UI calls returns for a range with none. */
export const MOCK_GENUI_EMPTY: GenuiStats = {
  totals: {
    calls: 0,
    turns: 0,
    firstAttempts: 0,
    firstTrySuccesses: 0,
    firstTryRate: null,
    retried: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
  },
  byToolModel: [],
  errors: [],
  byDay: [],
  costPerTurn: { turns: 0, avgUsd: null, p50Usd: null, p95Usd: null },
  latency: {
    firstFrame: { samples: 0, p50Ms: null, p95Ms: null },
    complete: { samples: 0, p50Ms: null, p95Ms: null },
  },
};
