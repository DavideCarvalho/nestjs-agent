import { type Mock, describe, expect, it, vi } from 'vitest';
import { AgentClient } from './client.js';

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, statusText: 'OK' });
}

/** The `fetch` arguments of one recorded call — fails loudly rather than destructuring `undefined`. */
function fetchCall(mock: Mock<typeof fetch>, index = 0): [string | Request | URL, RequestInit] {
  const call = mock.mock.calls[index];
  if (!call) throw new Error(`fetch was called fewer than ${index + 1} time(s)`);
  return [call[0], call[1] ?? {}];
}

describe('AgentClient', () => {
  describe('updateThread', () => {
    it('PATCHes the thread with the given patch', async () => {
      const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
      const client = new AgentClient({ baseUrl: 'https://api.example.com', fetch: fetchMock });

      const result = await client.updateThread('thr-1', { defaultAgent: 'researcher' });

      expect(result).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchCall(fetchMock);
      expect(url).toBe('https://api.example.com/agent/threads/thr-1');
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(String(init.body))).toEqual({ defaultAgent: 'researcher' });
    });

    it('sends defaultAgent: null to clear a previously-set default', async () => {
      const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
      const client = new AgentClient({ fetch: fetchMock });

      await client.updateThread('thr-1', { defaultAgent: null });

      const [, init] = fetchCall(fetchMock);
      expect(JSON.parse(String(init.body))).toEqual({ defaultAgent: null });
    });

    it('renameThread delegates to updateThread with just a title', async () => {
      const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
      const client = new AgentClient({ fetch: fetchMock });

      await client.renameThread('thr-1', 'New title');

      const [url, init] = fetchCall(fetchMock);
      expect(url).toBe('/agent/threads/thr-1');
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(String(init.body))).toEqual({ title: 'New title' });
    });
  });

  describe('uploadAttachment', () => {
    it('POSTs the file as multipart form data under field "file"', async () => {
      let capturedInit: RequestInit | undefined;
      const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
        capturedInit = init;
        return jsonResponse({
          mediaId: 'm1',
          url: 'https://cdn/a.png',
          contentType: 'image/png',
          name: 'a.png',
        });
      });
      const client = new AgentClient({ baseUrl: 'https://api.example.com', fetch: fetchMock });
      const file = new File(['bytes'], 'a.png', { type: 'image/png' });

      const attachment = await client.uploadAttachment(file);

      expect(attachment).toEqual({
        mediaId: 'm1',
        url: 'https://cdn/a.png',
        contentType: 'image/png',
        name: 'a.png',
      });
      const [url] = fetchCall(fetchMock);
      expect(url).toBe('https://api.example.com/agent/attachments');
      expect(capturedInit?.method).toBe('POST');
      expect(capturedInit?.body).toBeInstanceOf(FormData);
      expect((capturedInit?.body as FormData).get('file')).toBe(file);
      // No content-type header set — the browser must own the multipart boundary.
      const headers = new Headers(capturedInit?.headers);
      expect(headers.get('content-type')).toBeNull();
    });

    it('merges static + dynamic headers and forwards credentials', async () => {
      const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({}));
      const client = new AgentClient({
        headers: { 'x-tenant': 'acme' },
        getHeaders: () => ({ authorization: 'Bearer tok' }),
        credentials: 'include',
        fetch: fetchMock,
      });

      await client.uploadAttachment(new File(['x'], 'x.png', { type: 'image/png' }));

      const [, init] = fetchCall(fetchMock);
      const headers = new Headers(init.headers);
      expect(headers.get('x-tenant')).toBe('acme');
      expect(headers.get('authorization')).toBe('Bearer tok');
      expect(init.credentials).toBe('include');
    });

    it('throws AgentHttpError on a non-2xx response', async () => {
      const fetchMock = vi.fn<typeof fetch>(
        async () => new Response('', { status: 413, statusText: 'Payload Too Large' }),
      );
      const client = new AgentClient({ fetch: fetchMock });

      await expect(
        client.uploadAttachment(new File(['x'], 'x.png', { type: 'image/png' })),
      ).rejects.toMatchObject({ status: 413 });
    });
  });
});
