import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AgentUiController } from './agent-ui.controller.js';

/** A recording req/res pair matching the structural slices the controller reads/writes. */
function fakeReqRes(headers: Record<string, string | undefined>, originalUrl: string) {
  const statuses: number[] = [];
  const headersSet: Record<string, string> = {};
  return {
    req: { headers, originalUrl },
    res: {
      status: (code: number) => statuses.push(code),
      setHeader: (name: string, value: string) => {
        headersSet[name] = value;
      },
    },
    statuses,
    headersSet,
  };
}

describe('AgentUiController Inertia bounce (X-Inertia visits are full-page apps, not Inertia pages)', () => {
  const controller = new AgentUiController('/ai-gateway', '/ai-gateway/api');

  it('answers an X-Inertia visit with 409 + X-Inertia-Location echoing the original URL, no HTML', async () => {
    const { req, res, statuses, headersSet } = fakeReqRes(
      { 'x-inertia': 'true' },
      '/ai-gateway?tab=approvals',
    );

    const body = await controller.index(req, res);

    expect(statuses).toEqual([409]);
    // Path + query preserved — the client's full window.location visit lands on the same view.
    expect(headersSet['X-Inertia-Location']).toBe('/ai-gateway?tab=approvals');
    expect(body).toBe('');
  });

  it('a plain browser GET goes down the HTML-serving path untouched', async () => {
    const { req, res, statuses, headersSet } = fakeReqRes({}, '/ai-gateway');

    // The SPA bundle is not built in the unit-test env, so "today's behavior" past the bounce is
    // the not-built 404 — the point is the bounce did not fire: no status/headers were written.
    await expect(controller.index(req, res)).rejects.toThrow(NotFoundException);
    expect(statuses).toEqual([]);
    expect(headersSet).toEqual({});
  });
});
