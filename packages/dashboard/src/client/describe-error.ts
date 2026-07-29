/**
 * Turn whatever a governance query threw into the two things an operator needs on screen: what went
 * wrong, and whether it is worth pressing retry.
 *
 * A red box that says "error" is barely better than the blank section it replaced — the whole point
 * of surfacing a failure in a governance console is that "the API is down" and "you are signed out"
 * and "this host bound no pricing store" lead to three completely different next actions.
 *
 * `agentClient` throws `new Error(`${status} ${statusText}`)` for a non-2xx response, so the status
 * is recoverable from the message. A `fetch` that never got a response throws a `TypeError` with no
 * status at all — that is the "unreachable", not "refused", case.
 */
export interface DescribedError {
  /** The HTTP status the API answered with, or `null` when the request never got a response. */
  status: number | null;
  /** The raw thrown message, shown verbatim — never swallow the thing the server actually said. */
  message: string;
  /** What to do about it, in one sentence. Empty when there is nothing honest to suggest. */
  hint: string;
  /**
   * Whether pressing retry could plausibly change the answer. `false` for a `501` (the host is not
   * configured for this read) — offering retry there just teaches operators the button is a lie.
   */
  retryable: boolean;
}

const STATUS_PREFIX = /^(\d{3})\b/;

/** The status a `fetch` rejection carries in its message, or `null` when it never reached the API. */
export function errorStatus(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const matched = STATUS_PREFIX.exec(message);
  return matched?.[1] === undefined ? null : Number(matched[1]);
}

/** Describe a thrown query error for display. See {@link DescribedError}. */
export function describeError(error: unknown): DescribedError {
  const message =
    error instanceof Error && error.message !== ''
      ? error.message
      : typeof error === 'string' && error !== ''
        ? error
        : 'Unknown error';
  const status = errorStatus(error);

  if (status === null) {
    return {
      status: null,
      message,
      hint: 'The API did not answer at all — it may be down, or a proxy in front of it may be blocking the request.',
      retryable: true,
    };
  }
  if (status === 401 || status === 403) {
    return {
      status,
      message,
      hint: 'The console session was rejected. Reload the page to sign in again.',
      retryable: false,
    };
  }
  if (status === 404) {
    return {
      status,
      message,
      hint: 'The API answered, but not on this route — check that the dashboard module is mounted where the SPA thinks it is.',
      retryable: false,
    };
  }
  if (status === 501) {
    return {
      status,
      message,
      hint: 'This host has not bound the store this read needs, so there is nothing to retry — it is a configuration answer, not a failure.',
      retryable: false,
    };
  }
  if (status >= 500) {
    return {
      status,
      message,
      hint: 'The API reached this read and it failed. The server logs will say why.',
      retryable: true,
    };
  }
  return {
    status,
    message,
    hint: 'The API rejected this request. If a filter is set, it may be the filter.',
    retryable: true,
  };
}
