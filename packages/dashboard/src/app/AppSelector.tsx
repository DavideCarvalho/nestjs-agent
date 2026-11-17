import { useQuery } from '@tanstack/react-query';
import { APP_PARAM, agentClient, selectedApp } from '../client/agent-client';
import type { SectionKey } from './hash-section';

/** The empty choice: the console's own app. */
const LOCAL = '';

/** A federated console's app switcher data (`null` without federation). Fetched once. */
export function useConsoleFederation() {
  return useQuery({
    queryKey: ['federation'],
    queryFn: () => agentClient.federation(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/**
 * The URL that shows `app` (`''`: the console's own app): the current page with `?app=` set or
 * removed. The hash (section and its filters) is kept: they mean the same thing in every app, and
 * live apart from `?app=`.
 */
export function appHref(
  app: string,
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
): string {
  const params = new URLSearchParams(location.search);
  if (app === LOCAL) params.delete(APP_PARAM);
  else params.set(APP_PARAM, app);
  const qs = params.toString();
  return `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`;
}

/**
 * The app switcher of a federated console (the server's `federation` option): the console's own app
 * plus each app the viewer may see. Choosing one reloads the console on `?app=<name>`, so every
 * cached read is refetched for that app. Renders nothing on a console without federation.
 */
export function AppSelector() {
  const { data } = useConsoleFederation();
  if (!data || data.apps.length === 0) return null;
  const current = selectedApp() ?? LOCAL;
  return (
    <label className="flex h-[26px] items-center gap-1.5 rounded-md border border-border bg-panel-2 px-2 text-[11px]">
      <span className="hidden text-faint sm:inline">App</span>
      <select
        aria-label="App"
        data-testid="app-selector"
        className="bg-transparent font-medium text-fg-2 outline-none"
        value={current}
        onChange={(event) => {
          window.location.assign(appHref(event.target.value, window.location));
        }}
      >
        <option value={LOCAL}>{data.local.label}</option>
        {data.apps.map((app) => (
          <option key={app.name} value={app.name}>
            {app.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Pages served by this console's own process, which a federated app's view cannot show. */
const PROCESS_PAGES: ReadonlySet<SectionKey> = new Set(['live', 'pricing']);

/**
 * With a federated app selected, on a page this console's own process serves (the live feed, and
 * setting prices): says that the page can't show that app, and where to look instead. Nothing
 * elsewhere.
 */
export function FederatedAppNotice({ section }: { section: SectionKey }) {
  const { data } = useConsoleFederation();
  const app = selectedApp();
  if (app === undefined || !data || !PROCESS_PAGES.has(section)) return null;
  const label = data.apps.find((a) => a.name === app)?.label ?? app;
  return (
    <p
      role="note"
      data-testid="federated-app-notice"
      className="mb-4 rounded-md border border-border bg-panel-2 px-3 py-2 text-[12px] text-dim"
    >
      {label} is a federated app: this console reads its store, and sends its approvals to it. The
      live feed and price changes run in an app's own process, so open {label}'s own console for
      them.
    </p>
  );
}
