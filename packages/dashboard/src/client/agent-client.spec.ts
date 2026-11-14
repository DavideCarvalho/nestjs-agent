import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentClient } from './agent-client';

const EMPTY = {
  data: [],
  meta: { total: 0, perPage: 25, currentPage: 1, lastPage: 1, firstPage: 1 },
};

/** Stubs `fetch` and returns the decoded URLs it was called with. */
function capture(body: unknown = EMPTY): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(decodeURIComponent(url));
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('agentClient list reads (Aviary list wire)', () => {
  it('sends page, size and filter[field]=value, and skips empty filters', async () => {
    const urls = capture();
    await agentClient.runs({ page: 2, size: 10, filter: { status: 'failed', agentName: '' } });
    expect(urls).toEqual(['/ai-gateway/api/runs?page=2&size=10&filter[status]=failed']);
  });

  it('sends no query at all for a bare read', async () => {
    const urls = capture();
    await agentClient.toolCalls();
    await agentClient.approvals();
    expect(urls).toEqual(['/ai-gateway/api/tool-calls', '/ai-gateway/api/approvals']);
  });

  it('sends the thread title search as filter[title][contains]', async () => {
    const urls = capture();
    await agentClient.threads({ size: 25, filter: { title: 'triage', actorRef: 'user:1' } });
    expect(urls).toEqual([
      '/ai-gateway/api/threads?size=25&filter[title][contains]=triage&filter[actorRef]=user:1',
    ]);
  });

  it('returns the { data, meta } envelope as is', async () => {
    capture({ ...EMPTY, meta: { ...EMPTY.meta, total: 7 } });
    expect((await agentClient.approvals({ page: 1, size: 1 })).meta.total).toBe(7);
  });

  it('asks top-threads for a size and reads { data }', async () => {
    const urls = capture({ data: [] });
    await expect(
      agentClient.topThreads({ fromDay: '2026-07-01', toDay: '2026-07-30' }, 5),
    ).resolves.toEqual({ data: [] });
    expect(urls).toEqual(['/ai-gateway/api/top-threads?from=2026-07-01&to=2026-07-30&size=5']);
  });
});
