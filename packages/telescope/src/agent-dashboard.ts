import type { DashboardSpec } from '@dudousxd/nestjs-telescope';

/** The "Agent" overview dashboard. Panels bind to the `agent.*` data providers. */
export function agentDashboard(): DashboardSpec {
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
            title: 'Recent tool calls',
            data: { provider: 'agent.tools' },
            columns: [
              { key: 'toolName', label: 'Tool' },
              { key: 'toolType', label: 'Type' },
              { key: 'status', label: 'Status' },
              { key: 'runId', label: 'Run' },
            ],
          },
        ],
      },
    ],
  };
}
