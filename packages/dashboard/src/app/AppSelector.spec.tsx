// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ConsoleFederation, agentClient, selectedApp } from '../client/agent-client';
import { AppSelector, FederatedAppNotice, appHref } from './AppSelector';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/ai-gateway');
});

function stubFetch(federation: ConsoleFederation | null) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(federation), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function withClient(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const FEDERATION: ConsoleFederation = {
  local: { label: 'Hub' },
  apps: [
    { name: 'orders', label: 'Orders' },
    { name: 'billing', label: 'billing' },
  ],
};

describe('appHref', () => {
  it('sets or removes ?app=, keeping other params and the hash', () => {
    const at = { pathname: '/ai-gateway', search: '?x=1', hash: '#/runs?status=failed' };
    expect(appHref('orders', at)).toBe('/ai-gateway?x=1&app=orders#/runs?status=failed');
    expect(appHref('', { ...at, search: '?app=orders' })).toBe('/ai-gateway#/runs?status=failed');
  });
});

describe('selectedApp', () => {
  it('reads ?app= from the page URL', () => {
    expect(selectedApp()).toBeUndefined();
    window.history.replaceState(null, '', '/ai-gateway?app=orders#/runs');
    expect(selectedApp()).toBe('orders');
  });

  it('names the selected app on every API call', async () => {
    const fetchMock = stubFetch(null);
    window.history.replaceState(null, '', '/ai-gateway?app=orders');
    await agentClient.runs();
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('x-agent-app')).toBe('orders');
    // No selection, no header.
    window.history.replaceState(null, '', '/ai-gateway');
    await agentClient.runs();
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('x-agent-app')).toBeNull();
  });
});

describe('AppSelector', () => {
  it('lists the console app and the federated apps, with the selected one chosen', async () => {
    stubFetch(FEDERATION);
    window.history.replaceState(null, '', '/ai-gateway?app=orders');
    withClient(<AppSelector />);
    const select = (await screen.findByTestId('app-selector')) as HTMLSelectElement;
    expect([...select.options].map((o) => [o.value, o.text])).toEqual([
      ['', 'Hub'],
      ['orders', 'Orders'],
      ['billing', 'billing'],
    ]);
    expect(select.value).toBe('orders');
  });

  it('still lists the apps under a stale `?app=`: the switcher is asked without it', async () => {
    const fetchMock = stubFetch(FEDERATION);
    window.history.replaceState(null, '', '/ai-gateway?app=removed');
    withClient(<AppSelector />);
    await screen.findByTestId('app-selector');
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/federation$/);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('x-agent-app')).toBeNull();
  });

  it('renders nothing without federation', async () => {
    const fetchMock = stubFetch(null);
    const view = withClient(<AppSelector />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(view.container.innerHTML).toBe('');
  });
});

describe('FederatedAppNotice', () => {
  it("explains the pages a federated app's view cannot show", async () => {
    stubFetch(FEDERATION);
    window.history.replaceState(null, '', '/ai-gateway?app=orders');
    withClient(<FederatedAppNotice section="live" />);
    expect((await screen.findByTestId('federated-app-notice')).textContent).toContain(
      'Orders is a federated app',
    );
  });

  it('says nothing on a store-read page, or for the console app', async () => {
    const fetchMock = stubFetch(FEDERATION);
    window.history.replaceState(null, '', '/ai-gateway?app=orders');
    const view = withClient(<FederatedAppNotice section="runs" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(view.container.innerHTML).toBe('');
    cleanup();
    window.history.replaceState(null, '', '/ai-gateway');
    const local = withClient(<FederatedAppNotice section="live" />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(local.container.innerHTML).toBe('');
  });
});
