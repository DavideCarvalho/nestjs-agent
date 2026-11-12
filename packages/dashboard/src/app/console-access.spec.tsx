// @vitest-environment jsdom
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentClient } from '../client/agent-client';
import { AccessDenied } from './AccessDenied';
import { useConsoleAccess } from './use-console-access';

function respond(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, statusText: 'Denied' })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('console access in the SPA', () => {
  it('a 403 { error: "forbidden" } turns the console into the access-denied state', async () => {
    const navigate = vi.fn();
    const { result } = renderHook(() => useConsoleAccess(navigate));
    respond(403, { error: 'forbidden' });
    await act(async () => {
      await expect(agentClient.runs()).rejects.toThrow(/^403/);
    });
    await waitFor(() => expect(result.current.denied).toBe(true));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a 401 with redirectTo navigates there', async () => {
    const navigate = vi.fn();
    const { result } = renderHook(() => useConsoleAccess(navigate));
    respond(401, { error: 'unauthenticated', redirectTo: '/login?next=/ai-gateway' });
    await act(async () => {
      await expect(agentClient.runs()).rejects.toThrow(/^401/);
    });
    expect(navigate).toHaveBeenCalledWith('/login?next=/ai-gateway');
    expect(result.current.denied).toBe(false);
  });

  it('a 401 without redirectTo, or a 403 from something else, changes nothing', async () => {
    const navigate = vi.fn();
    const { result } = renderHook(() => useConsoleAccess(navigate));
    respond(401, { error: 'unauthenticated' });
    await act(async () => {
      await expect(agentClient.runs()).rejects.toThrow(/^401/);
    });
    respond(403, { message: 'proxy says no' });
    await act(async () => {
      await expect(agentClient.runs()).rejects.toThrow(/^403/);
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(result.current.denied).toBe(false);
  });

  it('the access-denied page says so', () => {
    render(<AccessDenied />);
    expect(screen.getByRole('alert').textContent).toMatch(/Access denied/);
  });
});
