import type { Column, DashboardSection, DashboardSpec } from '@dudousxd/nestjs-telescope';

/** A plain column, or one carrying a `Column.link` to `href` when `href` is given. */
function col(key: string, label: string, href?: string): Column {
  return href !== undefined ? { key, label, link: { href } } : { key, label };
}

/**
 * The "Agent" overview dashboard. Panels bind to the `agent.*` data providers.
 *
 * `threadHref` and `runHref` are URL templates for deep-linking a `{threadId}` / `{runId}` cell out
 * to the HOST's own viewer (e.g. the standalone `@dudousxd/nestjs-agent-dashboard` SPA). Both are
 * omitted by default, and a cell whose template is unset renders as plain text.
 *
 * `runHref` used to default to `'#/traces/{runId}'`, and that default could only 404. Telescope's
 * trace waterfall is keyed by **`traceId`** — `LinkSpec`'s doc says so, and `TracesService`
 * resolves it with `storage.get({ traceId })` — while an agent's `runId` is a different identifier
 * that {@link import('./agent-telescope.watcher.js').AgentTelescopeWatcher} never ties to one: it
 * records `type: 'agent'` entries and stamps no trace at all. So every `Run` cell on the shipped
 * dashboard pointed at a trace that does not exist, and clicking one answered
 * `404 · No entries for trace <runId>`. Substituting the wrong key into a route that had been read
 * correctly is the whole bug — hence no default here. A host that has a run viewer passes its own
 * template; one that does not gets plain text, which is honest.
 *
 * Layout: eight sections (Overview lean; Spend; Reliability; Activity; Approvals; Tools;
 * Retrieval; Retrieval sources), each sized so its panel count is an exact multiple of its `cols` —
 * no half-empty row. `nestjs-telescope`'s `ExtensionDashboardPage` renders a section as a
 * `grid-cols-N` grid with one panel per cell and no `colSpan`, so a lone table in an otherwise-empty
 * row would leave a visible gap next to it.
 *
 * `sections` appends HOST-contributed sections after the built-in ones — see
 * {@link import('./agent-telescope.extension.js').agentTelescopeExtension}'s `sections`/`providers`
 * options, which is the supported way an application puts its own panels (its knowledge-base
 * collections, its ingestion activity) on this page. They are appended rather than interleaved so a
 * host's layout can never push a built-in section out of the row it was sized for.
 */
export function agentDashboard(
  opts: { threadHref?: string; runHref?: string; sections?: DashboardSection[] } = {},
): DashboardSpec {
  const runHref = opts.runHref;
  return {
    id: 'agent.overview',
    label: 'Agent',
    panels: [],
    sections: [
      {
        // Lean: the headline runs/tokens/success numbers only — Reliability below has the detail.
        title: 'Overview',
        cols: 3,
        panels: [
          { kind: 'stat', title: 'Runs', data: { provider: 'agent.runs' } },
          { kind: 'stat', title: 'Tokens', data: { provider: 'agent.tokens' } },
          {
            kind: 'stat',
            title: 'Success rate',
            data: { provider: 'agent.runs.successRate' },
            format: 'percent',
          },
        ],
      },
      {
        title: 'Spend',
        cols: 4,
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
        title: 'Reliability',
        cols: 3,
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
          {
            kind: 'stat',
            title: 'Duration p50',
            data: { provider: 'agent.runs.duration', query: { metric: 'p50' } },
            format: 'duration',
          },
          {
            kind: 'stat',
            title: 'Duration p95',
            data: { provider: 'agent.runs.duration', query: { metric: 'p95' } },
            format: 'duration',
          },
          // Two duration stats above, not a `distribution` panel: RunMetrics carries only p50/p95
          // (no raw samples to bucket), so a histogram here would be a permanently-empty box.
          {
            kind: 'timeseries',
            title: 'Runs & failures',
            data: { provider: 'agent.runs.trend' },
            series: ['runs', 'failed'],
            style: 'stacked',
          },
          {
            kind: 'breakdown',
            title: 'Run errors',
            data: { provider: 'agent.runs.errors' },
            style: 'donut',
          },
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
        ],
      },
      {
        // The paged list tables: tool calls, threads, runs — each reads the paged SPI
        // (toolCallsPage/threadsPage/runsPage via `agent.*.paged`) and opts into the renderer's
        // pagination (`paged: true`, telescope >= 1.18): prev/next + "Page X of Y".
        title: 'Activity',
        cols: 3,
        panels: [
          {
            kind: 'table',
            title: 'Recent runs',
            paged: true,
            data: { provider: 'agent.runs.paged' },
            // A deliberate SUBSET of the provider's row shape: the full 11-field row overflows the
            // card horizontally. Thread/actor/retries/errorCode detail lives in the standalone
            // agent dashboard; the provider keeps returning the full row for other consumers.
            columns: [
              { key: 'startedAt', label: 'Started' },
              col('runId', 'Run', runHref),
              { key: 'agentName', label: 'Agent' },
              { key: 'status', label: 'Status' },
              { key: 'durationMs', label: 'Duration (ms)' },
              { key: 'errorMessage', label: 'Error' },
              { key: 'promptHash', label: 'Prompt' },
            ],
          },
          {
            kind: 'table',
            title: 'Recent tool calls',
            paged: true,
            data: { provider: 'agent.tools.paged' },
            columns: [
              { key: 'createdAt', label: 'When' },
              { key: 'toolName', label: 'Tool' },
              { key: 'toolType', label: 'Type' },
              { key: 'status', label: 'Status' },
              col('runId', 'Run', runHref),
              col('threadId', 'Thread', opts.threadHref),
            ],
          },
          {
            kind: 'table',
            title: 'Recently active threads',
            paged: true,
            data: { provider: 'agent.threads.paged' },
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
        cols: 2,
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
              col('runId', 'Run', runHref),
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
              { key: 'p50ExecutionMs', label: 'p50 (ms)' },
              { key: 'p95ExecutionMs', label: 'p95 (ms)' },
            ],
          },
        ],
      },
      {
        // RAG. Fed by the `aviary:rag:retrieval` telemetry `@dudousxd/nestjs-agent-rag` emits, NOT
        // derived from tool-call rows: a tool call that retrieved nothing and one that retrieved
        // five perfect passages are the same row with the same `ok` status, so every number here
        // would have been unanswerable from that side.
        title: 'Retrieval',
        cols: 3,
        panels: [
          { kind: 'stat', title: 'Retrievals', data: { provider: 'agent.rag.retrievals' } },
          {
            kind: 'stat',
            title: 'Zero-hit rate',
            data: { provider: 'agent.rag.zeroHitRate' },
            format: 'percent',
            // Up is bad and there is no "good" floor to calibrate against — a corpus that honestly
            // cannot answer a question SHOULD come back empty — so no thresholds: colouring this
            // would assert a target nobody measured.
          },
          {
            kind: 'stat',
            title: 'Passages per retrieval',
            data: { provider: 'agent.rag.chunks' },
            format: 'number',
          },
          {
            // A real histogram, unlike the run-duration pair above: retrieval events carry the raw
            // per-call duration, so there ARE samples to bucket and markers to place.
            kind: 'distribution',
            title: 'Retrieval latency',
            data: { provider: 'agent.rag.latency' },
            markers: ['p50', 'p95', 'p99'],
            format: 'duration',
          },
          {
            // Bound to ONE retriever kind on purpose — a cosine similarity, a BM25 score and an RRF
            // rank score share no scale, so a histogram over all of them has bins that mean a
            // different thing per bar. See `toScoreDistribution`.
            kind: 'distribution',
            title: 'Top score (dense)',
            data: { provider: 'agent.rag.scores', query: { retriever: 'embedding' } },
            markers: ['p50', 'p95'],
            format: 'number',
          },
          {
            kind: 'timeseries',
            title: 'Retrievals & zero-hits',
            data: { provider: 'agent.rag.trend' },
            series: ['retrievals', 'zeroHits'],
            style: 'stacked',
          },
        ],
      },
      {
        title: 'Retrieval sources',
        cols: 2,
        panels: [
          {
            kind: 'breakdown',
            title: 'Retrievals by store',
            data: { provider: 'agent.rag.byStore' },
            style: 'donut',
          },
          {
            kind: 'breakdown',
            title: 'Retrievals by retriever',
            data: { provider: 'agent.rag.byRetriever' },
            style: 'donut',
          },
          {
            kind: 'table',
            title: 'By collection',
            data: { provider: 'agent.rag.byCollection' },
            columns: [
              { key: 'collection', label: 'Collection' },
              { key: 'store', label: 'Store' },
              { key: 'retrievals', label: 'Retrievals' },
              { key: 'zeroHits', label: 'Zero-hits' },
              { key: 'p95Ms', label: 'p95 (ms)' },
              { key: 'meanTopScore', label: 'Mean top score' },
            ],
          },
          {
            kind: 'table',
            title: 'Slowest retrievals',
            data: { provider: 'agent.rag.slowest' },
            // Seven columns, matching the recent-runs table's width: this is the widest a table can
            // get here before it overflows its card.
            columns: [
              { key: 'at', label: 'When' },
              { key: 'retriever', label: 'Retriever' },
              { key: 'store', label: 'Store' },
              { key: 'collection', label: 'Collection' },
              { key: 'chunks', label: 'Passages' },
              { key: 'topScore', label: 'Top score' },
              { key: 'durationMs', label: 'Duration (ms)' },
            ],
          },
        ],
      },
      ...(opts.sections ?? []),
    ],
  };
}
