import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { OpenConsoleOptions } from '../client/console-session.js';
import { useOpenAgentConsole } from './use-open-console.js';

export interface OpenAgentConsoleButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children'>,
    OpenConsoleOptions {
  /** Button label. Defaults to "Open AI gateway". */
  children?: ReactNode;
  /** Shown while the session is being minted. Defaults to "Opening…". */
  pendingLabel?: ReactNode;
  /**
   * Render the refusal yourself. Omit and the button renders a plain `<p role="alert">` under
   * itself; pass `null` to render nothing and read the error from {@link useOpenAgentConsole}.
   */
  renderError?: ((error: Error) => ReactNode) | null;
}

/**
 * Drop-in launcher: the top tier, for a host that just wants a working button.
 *
 * Deliberately unstyled — it emits a bare `<button>` and forwards `className`/`style`/every other
 * button prop, so it inherits whatever design system the host already has instead of importing CSS
 * that would fight it. When it doesn't fit, drop to {@link useOpenAgentConsole} (same behaviour,
 * your markup) or to `openAgentConsole` (no React at all).
 *
 * The error is rendered by default rather than swallowed: a refused mint is the case a launcher most
 * needs to surface, and a button that silently does nothing reads as broken rather than forbidden.
 */
export function OpenAgentConsoleButton({
  children,
  pendingLabel,
  renderError,
  basePath,
  headers,
  fetch: fetchImpl,
  signal,
  navigate,
  disabled,
  ...buttonProps
}: OpenAgentConsoleButtonProps) {
  const { open, isPending, error } = useOpenAgentConsole({
    // Spread-if-defined rather than passing the keys through: the package compiles with
    // `exactOptionalPropertyTypes`, under which an explicit `basePath: undefined` is not assignable
    // to `basePath?: string`.
    ...(basePath !== undefined ? { basePath } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(navigate !== undefined ? { navigate } : {}),
  });

  return (
    <>
      <button
        type="button"
        {...buttonProps}
        onClick={open}
        disabled={disabled || isPending}
        aria-busy={isPending || undefined}
      >
        {isPending ? (pendingLabel ?? 'Opening…') : (children ?? 'Open AI gateway')}
      </button>
      {error &&
        renderError !== null &&
        (renderError?.(error) ?? <p role="alert">{error.message}</p>)}
    </>
  );
}
