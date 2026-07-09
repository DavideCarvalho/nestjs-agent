import type {
  ActorSpendRow,
  ModelSpendRow,
  SpendOverview,
  ThreadActivityRow,
  ThreadSpendRow,
  ToolCallActivityRow,
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
  { actorRef: 'tenant:acme', requests: 8200, totalTokens: 18_400_000, costUsd: 78.1 },
  { actorRef: 'user:davi@goflip.ai', requests: 3100, totalTokens: 6_900_000, costUsd: 34.2 },
  { actorRef: 'tenant:globex', requests: 4400, totalTokens: 9_200_000, costUsd: 21.8 },
  { actorRef: 'user:ops-bot', requests: 2100, totalTokens: 3_940_000, costUsd: 1.1 },
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

export const MOCK_SPEND: SpendOverview = {
  byModel: MODELS,
  byActor: ACTORS,
  trend: buildTrend(),
};

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
  },
  {
    threadId: 'th2',
    title: 'Incident triage',
    actorRef: 'user:ops-bot',
    messageCount: 11,
    totalTokens: 62_000,
    lastActivityAt: new Date(Date.now() - 400_000).toISOString(),
  },
  {
    threadId: 'th3',
    title: 'Contract summary',
    actorRef: 'user:davi@goflip.ai',
    messageCount: 6,
    totalTokens: 28_400,
    lastActivityAt: new Date(Date.now() - 1_800_000).toISOString(),
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
  },
  {
    threadId: 'th2',
    title: 'Incident triage',
    actorRef: 'user:ops-bot',
    requests: 11,
    totalTokens: 62_000,
    costUsd: 6.2,
  },
  {
    threadId: 'th3',
    title: 'Contract summary',
    actorRef: 'user:davi@goflip.ai',
    requests: 6,
    totalTokens: 28_400,
    costUsd: 2.8,
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
