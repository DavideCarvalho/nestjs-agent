// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentClient } from '../client.js';
import { useToolCatalog } from './use-tool-catalog.js';

const entries = [
  {
    name: 'query',
    kind: 'read',
    presentation: { label: 'Database query', running: 'Querying', done: 'Queried' },
  },
  { name: 'plain', kind: 'read' },
];

function clientWith(fetchImpl: typeof fetch): AgentClient {
  return new AgentClient({ fetch: fetchImpl });
}

describe('useToolCatalog', () => {
  it('asks GET /agent/tools once per client and agent, however many components ask', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(entries), { status: 200 }),
    );
    const client = clientWith(fetchMock);
    const first = renderHook(() => useToolCatalog({ client, agent: 'support' }));
    const second = renderHook(() => useToolCatalog({ client, agent: 'support' }));

    await waitFor(() => expect(first.result.current.isLoading).toBe(false));
    await waitFor(() => expect(second.result.current.isLoading).toBe(false));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/agent/tools?agent=support');
    expect(first.result.current.catalog).toEqual({ query: entries[0]?.presentation });
    expect(second.result.current.entries).toHaveLength(2);
  });

  it('reports a failure and retries on refresh', async () => {
    let attempt = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      attempt += 1;
      return attempt === 1
        ? new Response('nope', { status: 500, statusText: 'Server Error' })
        : new Response(JSON.stringify(entries), { status: 200 });
    });
    const client = clientWith(fetchMock);
    const { result } = renderHook(() => useToolCatalog({ client }));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    result.current.refresh();
    await waitFor(() => expect(result.current.catalog.query?.label).toBe('Database query'));
    expect(result.current.error).toBeNull();
  });

  it('holds the request while disabled', () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { result } = renderHook(() =>
      useToolCatalog({ client: clientWith(fetchMock), enabled: false }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });
});
