import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ConsoleSessionError,
  type OpenConsoleOptions,
  agentConsoleSessionUrl,
  openAgentConsole,
} from '../client/console-session.js';

/**
 * React layer over `openAgentConsole` — the middle tier between the bare function
 * (`../client/console-session.ts`) and the drop-in `<OpenAgentConsoleButton>`.
 *
 * You get the state a launcher UI actually needs (in-flight, error) and keep full control of the
 * markup. Nothing here is AI-gateway-specific beyond the endpoint: it is a mint-then-navigate call
 * with the two states that call can be in.
 */
export interface UseOpenConsoleResult {
  /** Start the mint-then-navigate. Never rejects — read `error` instead. */
  open: () => void;
  /** True from the click until the navigation starts, or until it fails. */
  isPending: boolean;
  /** The last refusal, or `null`. Cleared when `open()` is called again. */
  error: ConsoleSessionError | null;
  /** Drop a stale error without retrying — e.g. when a dialog closes. */
  reset: () => void;
}

export function useOpenAgentConsole(options: OpenConsoleOptions = {}): UseOpenConsoleResult {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<ConsoleSessionError | null>(null);

  // Kept in a ref so a caller passing an inline object literal (the common case) doesn't change the
  // identity of `open` on every render, which would defeat memoizing anything downstream.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const open = useCallback(() => {
    setIsPending(true);
    setError(null);
    void openAgentConsole(optionsRef.current)
      .then(() => {
        // Deliberately NOT clearing `isPending` on success: the navigation is already underway and
        // this component is about to be torn down. Flipping the button back to idle first produces
        // a visible flicker of "ready to click again" on a page that is leaving.
        //
        // "About to be torn down" is true only until the user presses Back — see the `pageshow`
        // effect below, which is the other half of this decision.
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof ConsoleSessionError
            ? cause
            : // Anything else got thrown before the client could classify it, so the endpoint is
              // the only context worth carrying — `ConsoleSessionError` takes the url, not a kind.
              new ConsoleSessionError(
                String(cause),
                agentConsoleSessionUrl(optionsRef.current.basePath),
              ),
        );
        setIsPending(false);
      });
  }, []);

  // The success path above leaves `isPending` stuck on purpose, which is only correct while the
  // page really is dying. It often isn't: `openAgentConsole` navigates with `location.assign`, and
  // a browser back/forward-cache hit FREEZES this page instead of destroying it — pressing Back
  // restores this component with the React state it fell asleep with, so the launcher wakes up
  // showing a spinner on a button that is disabled forever. Only a bfcache restore fires `pageshow`
  // with `persisted: true`, which makes it the one signal that distinguishes "you came back" from
  // "you loaded"; keying off anything looser (a plain `pageshow`, `visibilitychange`, `focus`)
  // would also fire while a mint is genuinely in flight and reintroduce the flicker the comment
  // above exists to prevent. So: clear it here, and ONLY here.
  useEffect(() => {
    // Guarded rather than assumed: this hook ships in a published package and hosts render it
    // through SSR, where `window` does not exist. (`window` is never touched at module scope.)
    if (typeof window === 'undefined') return;
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setIsPending(false);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const reset = useCallback(() => setError(null), []);

  return { open, isPending, error, reset };
}

/**
 * TanStack Query integration WITHOUT a TanStack dependency: the returned object is the shape
 * `useMutation` takes, so a host that already uses Query wires the launcher into its own cache,
 * devtools and error handling with no extra adapter — and a host that doesn't never pays for it.
 *
 * ```ts
 * const { mutate, isPending } = useMutation(openAgentConsoleMutationOptions({ headers }));
 * ```
 */
export function openAgentConsoleMutationOptions(options: OpenConsoleOptions = {}): {
  mutationKey: readonly unknown[];
  mutationFn: () => Promise<void>;
} {
  return {
    mutationKey: ['agent', 'console', 'open', options.basePath ?? null] as const,
    mutationFn: () => openAgentConsole(options),
  };
}
