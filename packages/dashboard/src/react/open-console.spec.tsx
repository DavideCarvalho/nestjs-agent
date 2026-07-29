// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OpenAgentConsoleButton } from './open-console-button.js';
import { openAgentConsoleMutationOptions } from './use-open-console.js';

function response(init: { status?: number; type?: string } = {}): Response {
  const status = init.status ?? 204;
  return { ok: status >= 200 && status < 300, status, type: init.type ?? 'basic' } as Response;
}

/**
 * A `pageshow` the hook can read. jsdom does not implement `PageTransitionEvent` in every version,
 * and the constructor is not what is under test — `event.persisted` is.
 */
function pageshowEvent(persisted: boolean): Event {
  return typeof PageTransitionEvent === 'function'
    ? new PageTransitionEvent('pageshow', { persisted })
    : Object.assign(new Event('pageshow'), { persisted });
}

describe('openAgentConsoleMutationOptions', () => {
  it('returns a useMutation-shaped object without depending on TanStack', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    const navigate = vi.fn();
    const options = openAgentConsoleMutationOptions({ fetch: fetchMock, navigate });

    // The point of the shape: a host passes this straight into `useMutation`, and this package
    // never imports @tanstack/react-query — so a host that doesn't use Query pays nothing.
    expect(options.mutationKey).toEqual(['agent', 'console', 'open', null]);
    await options.mutationFn();
    expect(navigate).toHaveBeenCalledWith('/ai-gateway');
  });

  it('keys by basePath so two mounts do not share cache state', () => {
    expect(openAgentConsoleMutationOptions({ basePath: '/ops' }).mutationKey).toEqual([
      'agent',
      'console',
      'open',
      '/ops',
    ]);
  });
});

describe('<OpenAgentConsoleButton>', () => {
  it('mints and navigates on click', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    const navigate = vi.fn();
    render(<OpenAgentConsoleButton fetch={fetchMock} navigate={navigate} />);

    await act(async () => {
      screen.getByRole('button').click();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/ai-gateway/auth/session',
      expect.objectContaining({ method: 'POST' }),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/ai-gateway'));
  });

  it('surfaces a refusal instead of failing silently', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 403 }));
    render(<OpenAgentConsoleButton fetch={fetchMock} navigate={vi.fn()} />);

    await act(async () => {
      screen.getByRole('button').click();
    });

    // A button that silently does nothing reads as broken rather than forbidden — the single most
    // important behaviour for a launcher, and the reason the error renders by default.
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/HTTP 403/));
  });

  it('does not navigate when the mint is refused', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 401 }));
    const navigate = vi.fn();
    render(<OpenAgentConsoleButton fetch={fetchMock} navigate={navigate} />);

    await act(async () => {
      screen.getByRole('button').click();
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(navigate).not.toHaveBeenCalled();
  });

  it('renders a custom error node when asked', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 403 }));
    render(
      <OpenAgentConsoleButton
        fetch={fetchMock}
        navigate={vi.fn()}
        renderError={(error) => <span data-testid="mine">{error.message}</span>}
      />,
    );

    await act(async () => {
      screen.getByRole('button').click();
    });

    await waitFor(() => expect(screen.getByTestId('mine')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders nothing for the error when renderError is null', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 403 }));
    render(<OpenAgentConsoleButton fetch={fetchMock} navigate={vi.fn()} renderError={null} />);

    await act(async () => {
      screen.getByRole('button').click();
    });

    // Opting out entirely must be possible for a host that surfaces errors its own way (a toast).
    await waitFor(() =>
      expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('forwards button props so it inherits the host design system', () => {
    render(
      <OpenAgentConsoleButton className="btn btn-primary" data-testid="launcher" title="Open it" />,
    );

    // Unstyled-and-forwarding is the whole reason this ships no CSS.
    const button = screen.getByTestId('launcher');
    expect(button.className).toBe('btn btn-primary');
    expect(button.getAttribute('title')).toBe('Open it');
    expect(button.textContent).toBe('Open AI gateway');
  });

  it('disables itself while in flight', async () => {
    let release: (value: Response) => void = () => {};
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    render(<OpenAgentConsoleButton fetch={fetchMock} navigate={vi.fn()} />);
    const button = screen.getByRole('button');

    await act(async () => {
      button.click();
    });

    // Without this a double-click fires two mints, and the second can land after the navigation.
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      release(response());
    });
  });

  it('stays disabled after a successful mint, because the page is leaving', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    const navigate = vi.fn();
    render(<OpenAgentConsoleButton fetch={fetchMock} navigate={navigate} />);
    const button = screen.getByRole('button') as HTMLButtonElement;

    await act(async () => {
      button.click();
    });
    await waitFor(() => expect(navigate).toHaveBeenCalled());

    // The anti-flicker guarantee: returning to idle on a page that is unloading shows a "ready to
    // click again" frame the user reads as a failed click. Nothing below may regress this.
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });
});

describe('<OpenAgentConsoleButton> and the back/forward cache', () => {
  it('re-enables the button when the page is restored from the bfcache', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    const navigate = vi.fn();
    render(<OpenAgentConsoleButton fetch={fetchMock} navigate={navigate} />);
    const button = screen.getByRole('button') as HTMLButtonElement;

    await act(async () => {
      button.click();
    });
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(button.disabled).toBe(true);

    // Back out of the console: the page was frozen, not destroyed, so this component wakes up with
    // the `isPending` it went to sleep with — a spinner on a button that can never be clicked again.
    await act(async () => {
      window.dispatchEvent(pageshowEvent(true));
    });

    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-busy')).toBeNull();
  });

  it('leaves an in-flight mint spinning on a non-persisted pageshow', async () => {
    let release: (value: Response) => void = () => {};
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    render(<OpenAgentConsoleButton fetch={fetchMock} navigate={vi.fn()} />);
    const button = screen.getByRole('button') as HTMLButtonElement;

    await act(async () => {
      button.click();
    });

    // A fresh load fires `pageshow` too. Treating it as a restore would cancel the spinner of a
    // mint that is genuinely still running, which is the flicker this hook exists to avoid.
    await act(async () => {
      window.dispatchEvent(pageshowEvent(false));
    });

    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      release(response());
    });
  });

  it('removes the pageshow listener on unmount', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    try {
      const { unmount } = render(<OpenAgentConsoleButton fetch={vi.fn()} navigate={vi.fn()} />);

      const registered = add.mock.calls.filter(([type]) => type === 'pageshow');
      expect(registered).toHaveLength(1);
      const handler = registered[0]?.[1];

      unmount();

      // A launcher that lives in a header gets mounted on every page; a listener per mount is a
      // leak, and a survivor would set state on a component that no longer exists.
      const unregistered = remove.mock.calls.some(
        ([type, fn]) => type === 'pageshow' && fn === handler,
      );
      expect(unregistered).toBe(true);

      expect(() => window.dispatchEvent(pageshowEvent(true))).not.toThrow();
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });
});
