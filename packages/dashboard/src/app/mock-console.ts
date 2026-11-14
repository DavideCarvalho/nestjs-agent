import {
  MOCK_APPROVALS_PAGE,
  MOCK_GENUI_STATS,
  MOCK_PRICES,
  MOCK_RELIABILITY,
  MOCK_RUNS,
  MOCK_RUNS_PAGE,
  MOCK_RUN_DETAIL,
  MOCK_SPEND,
  MOCK_THREADS,
  MOCK_THREADS_PAGE,
  MOCK_THREAD_DETAIL,
  MOCK_TOOL_CALLS_PAGE,
  MOCK_TOOL_STATS,
  MOCK_TOP_THREADS,
} from './mock-data';

/**
 * The mock data, served to the WHOLE `App` by stubbing `fetch` (and `EventSource`). Used only by
 * `preview.html?view=console` — the standalone visual-verification entry — so the shell, every page,
 * the drill-down drawer and ⌘K can be screenshotted with their real components and styling, with no
 * server and no store. Deep-link a page the way the real console does: `?view=console#/reliability`.
 */

const API = '/ai-gateway/api';

const consoles = {
  version: 1,
  current: 'agent',
  consoles: [
    { id: 'durable', title: 'Workflows', icon: 'workflow', href: '/durable' },
    { id: 'telescope', title: 'Telescope', icon: 'telescope', href: '/telescope' },
    { id: 'media', title: 'Media', icon: 'media', href: '/media' },
  ],
};

const tenancy = {
  enabled: true,
  scope: 'tenant',
  tenant: { id: 'acme', kind: 'organization', label: 'Acme Corp' },
  chain: [{ id: 'acme', kind: 'organization', label: 'Acme Corp' }],
};

/** Per-console ⌘K answers, each after its own delay, so the streaming groups can be seen. */
const SEARCH_DELAY_MS: Record<string, number> = {
  agent: 150,
  durable: 700,
  telescope: 1400,
  media: 2400,
};

function searchBody(search: string | undefined): unknown {
  const params = new URLSearchParams(search ?? '');
  const q = (params.get('q') ?? '').toLowerCase();
  const only = params.get('console');
  const groups = [
    {
      id: 'agent',
      title: 'Agents',
      icon: 'agent',
      hits: [
        ...MOCK_RUNS.filter((r) => r.runId.toLowerCase().includes(q)).map((r) => ({
          title: `Run ${r.runId}`,
          subtitle: `${r.agentName ?? 'agent'} · ${r.status}`,
          href: `/ai-gateway#/runs?run=${r.runId}`,
        })),
        ...MOCK_THREADS.filter((t) => (t.title ?? '').toLowerCase().includes(q)).map((t) => ({
          title: t.title || t.threadId,
          subtitle: `Thread · ${t.messageCount} messages`,
          href: `/ai-gateway#/runs?thread=${t.threadId}`,
        })),
      ].slice(0, 5),
    },
    {
      id: 'durable',
      title: 'Workflows',
      icon: 'workflow',
      hits: [
        { title: 'ord-9f2c1a4b', subtitle: 'run · checkout · failed', href: '/durable#/run/x' },
        { title: 'checkout', subtitle: 'workflow · 4 versions', href: '/durable#/workflow/x' },
      ],
    },
    {
      id: 'telescope',
      title: 'Telescope',
      icon: 'telescope',
      hits: [{ title: 'POST /agents/chat 500', subtitle: 'request · 2m ago', href: '/telescope' }],
    },
    { id: 'media', title: 'Media', icon: 'media', hits: [] },
  ].filter((group) => group.hits.length > 0 && (only === null || group.id === only));
  return { version: 1, q, partial: false, results: groups };
}

function body(path: string): unknown {
  const [route, search] = path.split('?');
  switch (route) {
    case '/tenancy':
      return tenancy;
    case '/spend':
      return MOCK_SPEND;
    case '/top-threads':
      return { data: MOCK_TOP_THREADS };
    case '/reliability':
      return MOCK_RELIABILITY;
    case '/runs':
      return MOCK_RUNS_PAGE;
    case '/tool-calls':
      return MOCK_TOOL_CALLS_PAGE;
    case '/threads':
      return MOCK_THREADS_PAGE;
    case '/approvals':
      return MOCK_APPROVALS_PAGE;
    case '/tools':
      return MOCK_TOOL_STATS;
    case '/genui':
      return MOCK_GENUI_STATS;
    case '/pricing':
      return MOCK_PRICES;
    case '/consoles':
      return consoles;
    case '/consoles/search':
      return searchBody(search);
  }
  if (route?.startsWith('/runs/')) return MOCK_RUN_DETAIL;
  if (route?.startsWith('/threads/')) return MOCK_THREAD_DETAIL;
  return undefined;
}

/** An `EventSource` that connects and stays quiet: the live indicator reads connected. */
class QuietEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close(): void {}
}

/**
 * Point the SPA's `fetch` at the mock data above. Anything outside the agent API (fonts, assets) is
 * handed back to the real `fetch`, so the page still loads normally.
 */
export function installMockConsoleApi(): void {
  // The shell fields the server would put in the page's data block.
  const block = document.createElement('script');
  block.type = 'application/json';
  block.id = 'agent-dashboard-config';
  block.textContent = JSON.stringify({
    apiBase: API,
    switcher: { endpoint: `${API}/consoles`, others: 3 },
    search: { endpoint: `${API}/consoles/search`, self: 'agent' },
    viewer: { label: 'Ann Lee', email: 'ann@acme.test', role: 'admin' },
    signOut: { action: '/logout', csrfToken: 'preview' },
  });
  document.head.appendChild(block);
  window.__AGENT_API__ = API;
  (window as unknown as { EventSource: unknown }).EventSource = QuietEventSource;
  const real = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const match = url.match(/\/ai-gateway\/api(\/.*)$/);
    const payload = match?.[1] ? body(match[1]) : undefined;
    if (payload === undefined) return real(input as RequestInfo, init);
    const only = match?.[1]?.startsWith('/consoles/search')
      ? new URLSearchParams(match[1].split('?')[1] ?? '').get('console')
      : null;
    if (only) await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS[only] ?? 300));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}
