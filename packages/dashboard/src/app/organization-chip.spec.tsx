// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleTenancy } from '../client/agent-client';
import { OrganizationChip } from './OrganizationChip';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderWith(tenancy: ConsoleTenancy) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL) => new Response(JSON.stringify(tenancy), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <OrganizationChip />
    </QueryClientProvider>,
  );
  return { fetchMock, view };
}

describe('OrganizationChip', () => {
  it("shows the labelled path down to the console's level", async () => {
    const { fetchMock } = renderWith({
      enabled: true,
      scope: 'tenant',
      tenant: { id: 'U1', kind: 'unit', label: 'Unit One' },
      chain: [
        { id: 'C1', kind: 'clinic', label: 'Clinic One' },
        { id: 'U1', kind: 'unit', label: 'Unit One' },
      ],
    });
    const chip = await screen.findByTestId('organization-chip');
    expect(chip.textContent).toContain('Clinic One › Unit One');
    expect(chip.getAttribute('title')).toBe('clinic C1 › unit U1');
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/tenancy$/);
  });

  it('says so when the console sees every organization, or none', async () => {
    renderWith({ enabled: true, scope: 'all', tenant: null, chain: [] });
    expect((await screen.findByTestId('organization-chip')).textContent).toContain(
      'All organizations',
    );
    cleanup();
    renderWith({ enabled: true, scope: 'tenantless', tenant: null, chain: [] });
    expect((await screen.findByTestId('organization-chip')).textContent).toContain(
      'No organization',
    );
  });

  it('renders nothing with tenancy off', async () => {
    const { fetchMock, view } = renderWith({
      enabled: false,
      scope: 'all',
      tenant: null,
      chain: [],
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.container.innerHTML).toBe('');
  });
});
