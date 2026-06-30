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
