import { describe, expect, it, vi } from 'vitest';
import { AgentClient, AgentHttpError } from './client.js';

function jsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}) {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  };
}

describe('AgentClient — settling a question set', () => {
  it('POSTs the chosen answers to the answer endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const client = new AgentClient({ baseUrl: 'https://api.example.com', fetch: fetchMock });

    await client.answerToolCall({ toolCallId: 'intake-run-1', answers: { scope: ['file'] } });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/agent/tool-call/answer');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      toolCallId: 'intake-run-1',
      answers: { scope: ['file'] },
    });
  });

  it('omits answers entirely when the user just confirmed, so the server applies its own defaults', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const client = new AgentClient({ fetch: fetchMock });

    await client.answerToolCall({ toolCallId: 'intake-run-1' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ toolCallId: 'intake-run-1' });
  });

  it('POSTs a skip under its own endpoint — a declined question is not an answered one', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const client = new AgentClient({ fetch: fetchMock });

    await client.skipToolCall({ toolCallId: 'intake-run-1' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/agent/tool-call/skip');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ toolCallId: 'intake-run-1' });
  });

  it('raises the HTTP status, the same way approve/reject do', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, { status: 403, statusText: 'Forbidden' }));
    const client = new AgentClient({ fetch: fetchMock });

    await expect(client.answerToolCall({ toolCallId: 'not-mine' })).rejects.toThrow(AgentHttpError);
    await expect(client.skipToolCall({ toolCallId: 'not-mine' })).rejects.toMatchObject({
      status: 403,
    });
  });
});
