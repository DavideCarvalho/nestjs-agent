import { type Mock, describe, expect, it, vi } from 'vitest';
import { AgentClient } from './client.js';

const QUEUED = {
  queued: true,
  threadId: 'thr-1',
  messageId: 'q-1',
  position: 0,
  queue: { items: [{ id: 'q-1', content: 'hi', createdAt: 'x', updatedAt: 'x' }], paused: null },
};
const STATE = { items: [], paused: null };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function call(mock: Mock<typeof fetch>, index = 0): [string, RequestInit] {
  const recorded = mock.mock.calls[index];
  if (!recorded) throw new Error(`fetch was called fewer than ${index + 1} time(s)`);
  return [String(recorded[0]), recorded[1] ?? {}];
}

describe('AgentClient — the message queue', () => {
  it('reports a 202 from POST chat as a queued send, with an empty stream', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(QUEUED, 202));
    const client = new AgentClient({ fetch: fetchMock });
    const response = await client.openChatStream({ body: { threadId: 'thr-1', message: 'hi' } });
    expect(response.queued).toEqual(QUEUED);
    expect((await response.body.getReader().read()).done).toBe(true);
  });

  it('enqueues through POST chat with mode queue unless the body names one', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(QUEUED, 202));
    const client = new AgentClient({ fetch: fetchMock });
    expect(await client.enqueueMessage({ body: { threadId: 'thr-1', message: 'hi' } })).toEqual(
      QUEUED,
    );
    await client.enqueueMessage({ body: { threadId: 'thr-1', message: 'now', mode: 'interrupt' } });
    const [url, init] = call(fetchMock);
    expect(url).toBe('/agent/chat');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      mode: 'queue',
      threadId: 'thr-1',
      message: 'hi',
    });
    expect(JSON.parse(String(call(fetchMock, 1)[1].body)).mode).toBe('interrupt');
  });

  it.each([
    [
      'getQueue',
      (c: AgentClient) => c.getQueue('t 1'),
      'GET',
      '/agent/threads/t%201/queue',
      undefined,
    ],
    [
      'updateQueuedMessage',
      (c: AgentClient) => c.updateQueuedMessage('q-1', { message: 'x', position: 2 }),
      'PATCH',
      '/agent/queue/q-1',
      { message: 'x', position: 2 },
    ],
    [
      'removeQueuedMessage',
      (c: AgentClient) => c.removeQueuedMessage('q-1'),
      'DELETE',
      '/agent/queue/q-1',
      undefined,
    ],
    [
      'clearQueue',
      (c: AgentClient) => c.clearQueue('thr-1'),
      'DELETE',
      '/agent/threads/thr-1/queue',
      undefined,
    ],
    [
      'resumeQueue',
      (c: AgentClient) => c.resumeQueue('thr-1'),
      'POST',
      '/agent/threads/thr-1/queue/resume',
      undefined,
    ],
  ])('%s → %s %s', async (_name, run, method, path, body) => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(STATE));
    const client = new AgentClient({ fetch: fetchMock });
    expect(await run(client)).toEqual(STATE);
    const [url, init] = call(fetchMock);
    expect(init.method).toBe(method);
    expect(url).toBe(path);
    expect(init.body === undefined ? undefined : JSON.parse(String(init.body))).toEqual(body);
  });
});
