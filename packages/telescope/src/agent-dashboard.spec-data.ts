import type { Column, DashboardSpec } from '@dudousxd/nestjs-telescope';

/** A plain column, or one carrying a `Column.link` to `href` when `href` is given. */
function col(key: string, label: string, href?: string): Column {
  return href !== undefined ? { key, label, link: { href } } : { key, label };
}

/**
 * The "Agent" overview dashboard. Panels bind to the `agent.*` data providers.
 *
 * `threadHref`/`runHref` are URL templates for deep-linking a `{threadId}`/`{runId}` cell out to
 * the host's own thread/run viewer (e.g. the standalone `@dudousxd/nestjs-agent-dashboard` SPA),
 * mirroring `durableTelescopeExtension`'s `runHref` option. Every table whose rows carry a
 * `threadId`/`runId` gets a `Column.link` for it (via {@link col}); omit an option to leave that
 * column plain text.
 */
export function agentDashboard(
  opts: { threadHref?: string; runHref?: string } = {},
): DashboardSpec {
  return {
    id: 'agent.overview',
    label: 'Agent',
    panels: [],
    sections: [
      {
        title: 'Overview',
        cols: 2,
        panels: [
          { kind: 'stat', title: 'Runs', data: { provider: 'agent.runs' } },
          { kind: 'stat', title: 'Tokens', data: { provider: 'agent.tokens' } },
        ],
      },
      {
        title: 'Reliability',
        cols: 4,
        panels: [
          { kind: 'stat', title: 'Runs', data: { provider: 'agent.runs.total' } },
          {
            kind: 'stat',
            title: 'Success rate',
            data: { provider: 'agent.runs.successRate' },
            format: 'percent',
          },
          { kind: 'stat', title: 'Failed', data: { provider: 'agent.runs.failed' } },
          { kind: 'stat', title: 'Retries', data: { provider: 'agent.runs.retries' } },
        ],
      },
      {
        title: 'Run trends',
        cols: 3,
        panels: [
          {
            kind: 'timeseries',
            title: 'Runs & failures',
            data: { provider: 'agent.runs.trend' },
            series: ['runs', 'failed'],
            style: 'stacked',
          },
          {
            kind: 'distribution',
            title: 'Run duration',
            data: { provider: 'agent.runs.duration' },
            markers: ['p50', 'p95'],
            format: 'duration',
          },
          {
            kind: 'breakdown',
            title: 'Run errors',
            data: { provider: 'agent.runs.errors' },
            style: 'donut',
          },
        ],
      },
      {
        title: 'Runs',
        panels: [
          {
            kind: 'table',
            title: 'Runs by agent',
            data: { provider: 'agent.runs.byAgent' },
            columns: [
              { key: 'agentName', label: 'Agent' },
              { key: 'runs', label: 'Runs' },
              { key: 'failed', label: 'Failed' },
              { key: 'retries', label: 'Retries' },
            ],
          },
          {
            kind: 'table',
            title: 'Recent runs',
            data: { provider: 'agent.runs.recent' },
            columns: [
              { key: 'startedAt', label: 'Started' },
              col('runId', 'Run', opts.runHref),
              col('threadId', 'Thread', opts.threadHref),
              { key: 'actorRef', label: 'Actor' },
              { key: 'agentName', label: 'Agent' },
              { key: 'status', label: 'Status' },
              { key: 'durationMs', label: 'Duration (ms)' },
              { key: 'retries', label: 'Retries' },
              { key: 'errorCode', label: 'Error code' },
              { key: 'errorMessage', label: 'Error' },
              { key: 'promptHash', label: 'Prompt' },
            ],
          },
        ],
      },
      {
        title: 'Spend',
        cols: 2,
        panels: [
          {
            kind: 'stat',
            title: 'Total spend (USD)',
            data: { provider: 'agent.spend.totalCost' },
            format: 'number',
          },
          {
            kind: 'stat',
            title: 'Total tokens',
            data: { provider: 'agent.spend.totalTokens' },
            format: 'number',
          },
          {
            kind: 'breakdown',
            title: 'Spend by model',
            data: { provider: 'agent.spend.byModel' },
            style: 'donut',
          },
          {
            kind: 'timeseries',
            title: 'Daily spend & tokens',
            data: { provider: 'agent.usage.trend' },
            series: ['costUsd', 'totalTokens'],
            style: 'area',
          },
        ],
      },
      {
        title: 'Models',
        panels: [
          {
            kind: 'table',
            title: 'Usage & cost by model',
            data: { provider: 'agent.spend.byModelTable' },
            columns: [
              { key: 'modelId', label: 'Model' },
              { key: 'requests', label: 'Requests' },
              { key: 'inputTokens', label: 'Input tokens' },
              { key: 'outputTokens', label: 'Output tokens' },
              { key: 'costUsd', label: 'Cost (USD)' },
            ],
          },
        ],
      },
      {
        title: 'Actors',
        cols: 2,
        panels: [
          {
            kind: 'breakdown',
            title: 'Spend share by actor',
            data: { provider: 'agent.spend.byActorShare' },
            style: 'bar',
          },
          {
            kind: 'table',
            title: 'Spend by actor',
            data: { provider: 'agent.spend.byActor' },
            columns: [
              { key: 'actorRef', label: 'Actor' },
              { key: 'requests', label: 'Requests' },
              { key: 'totalTokens', label: 'Tokens' },
              { key: 'costUsd', label: 'Cost (USD)' },
            ],
          },
        ],
      },
      {
        title: 'Threads',
        cols: 2,
        panels: [
          {
            kind: 'table',
            title: 'Top threads by cost',
            data: { provider: 'agent.threads.topSpend' },
            columns: [
              { key: 'title', label: 'Thread' },
              { key: 'actorRef', label: 'Actor' },
              { key: 'requests', label: 'Requests' },
              { key: 'totalTokens', label: 'Tokens' },
              { key: 'costUsd', label: 'Cost (USD)' },
            ],
          },
          {
            kind: 'table',
            title: 'Recently active threads',
            data: { provider: 'agent.threads.recent' },
            columns: [
              col('threadId', 'Thread', opts.threadHref),
              { key: 'title', label: 'Title' },
              { key: 'actorRef', label: 'Actor' },
              { key: 'messageCount', label: 'Messages' },
              { key: 'totalTokens', label: 'Tokens' },
              { key: 'lastActivityAt', label: 'Last activity' },
            ],
          },
        ],
      },
      {
        title: 'Approvals',
        cols: 3,
        panels: [
          {
            kind: 'stat',
            title: 'Pending approvals',
            data: { provider: 'agent.approvals.pending' },
          },
          {
            kind: 'table',
            title: 'Approvals inbox',
            data: { provider: 'agent.approvals.recent' },
            columns: [
              { key: 'requestedAt', label: 'Requested' },
              { key: 'toolName', label: 'Tool' },
              { key: 'threadTitle', label: 'Thread' },
              col('threadId', 'Thread id', opts.threadHref),
              { key: 'actorRef', label: 'Actor' },
              { key: 'agentName', label: 'Agent' },
            ],
          },
        ],
      },
      {
        title: 'Tools',
        cols: 2,
        panels: [
          {
            kind: 'breakdown',
            title: 'Tool-call status',
            data: { provider: 'agent.toolStatus' },
            style: 'donut',
          },
          {
            kind: 'table',
            title: 'Tool stats',
            data: { provider: 'agent.tools.stats' },
            columns: [
              { key: 'toolName', label: 'Tool' },
              { key: 'toolType', label: 'Type' },
              { key: 'calls', label: 'Calls' },
              { key: 'failed', label: 'Failed' },
              { key: 'rejected', label: 'Rejected' },
              { key: 'p95ExecutionMs', label: 'p95 (ms)' },
            ],
          },
          {
            kind: 'table',
            title: 'Recent tool calls',
            data: { provider: 'agent.tools.recent' },
            columns: [
              { key: 'createdAt', label: 'When' },
              { key: 'toolName', label: 'Tool' },
              { key: 'toolType', label: 'Type' },
              { key: 'status', label: 'Status' },
              col('threadId', 'Thread', opts.threadHref),
            ],
          },
        ],
      },
    ],
  };
}
