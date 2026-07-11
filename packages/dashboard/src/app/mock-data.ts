import type {
  ActorSpendRow,
  ModelPrice,
  ModelSpendRow,
  PendingApprovalRow,
  RecentRunRow,
  ReliabilityOverview,
  RunTrendPoint,
  SpendOverview,
  ThreadActivityRow,
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
  },
  {
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
  },
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
  },
];

export const MOCK_PENDING_APPROVALS: PendingApprovalRow[] = [
  {
    toolCallId: 'tc-approve-1',
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
    p95ExecutionMs: 180,
  },
  {
    toolName: 'delete_asset',
    toolType: 'action',
    calls: 34,
    failed: 1,
    rejected: 4,
    p95ExecutionMs: 620,
  },
  {
    toolName: 'send_email',
    toolType: 'action',
    calls: 58,
    failed: 2,
    rejected: 2,
    p95ExecutionMs: 410,
  },
  {
    toolName: 'fetch_pricing',
    toolType: 'read',
    calls: 210,
    failed: 0,
    rejected: 0,
    p95ExecutionMs: 95,
  },
];

export const MOCK_BUDGETS = BUDGETS;

export const MOCK_TOOL_CALLS: ToolCallActivityRow[] = [
  {
    toolCallId: 'tc1',
    toolName: 'search_records',
    toolType: 'read',
    status: 'ok',
    threadId: 'th1',
    createdAt: new Date(Date.now() - 12_000).toISOString(),
  },
  {
    toolCallId: 'tc2',
    toolName: 'delete_asset',
    toolType: 'action',
    status: 'forbidden',
    threadId: 'th2',
    createdAt: new Date(Date.now() - 90_000).toISOString(),
  },
  {
    toolCallId: 'tc3',
    toolName: 'fetch_pricing',
    toolType: 'read',
    status: 'ok',
    threadId: 'th1',
    createdAt: new Date(Date.now() - 240_000).toISOString(),
  },
  {
    toolCallId: 'tc4',
    toolName: 'send_email',
    toolType: 'action',
    status: 'failed',
    threadId: 'th3',
    createdAt: new Date(Date.now() - 620_000).toISOString(),
  },
  {
    toolCallId: 'tc5',
    toolName: 'summarize_thread',
    toolType: 'read',
    status: 'ok',
    threadId: 'th2',
    createdAt: new Date(Date.now() - 1_200_000).toISOString(),
  },
];

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
  {
    threadId: 'th2',
    title: 'Incident triage',
    actorRef: 'user:ops-bot',
    messageCount: 11,
    totalTokens: 62_000,
    lastActivityAt: new Date(Date.now() - 400_000).toISOString(),
    actorLabel: null,
  },
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
