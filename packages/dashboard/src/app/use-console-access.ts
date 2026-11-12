import { useEffect, useState } from 'react';
import { type ConsoleAccessEvent, onConsoleAccess } from '../client/agent-client';

/** Follows a `redirectTo` the console's `authorize` answered with (sign-in), in the browser. */
function redirect(to: string): void {
  window.location.assign(to);
}

/**
 * Whether the API said this browser may not use the console (a 403 `{ error: 'forbidden' }`). A 401
 * carrying `redirectTo` navigates there instead, so the app's own sign-in takes over.
 */
export function useConsoleAccess(navigate: (to: string) => void = redirect): { denied: boolean } {
  const [denied, setDenied] = useState(false);

  useEffect(
    () =>
      onConsoleAccess((event: ConsoleAccessEvent) => {
        if (event.kind === 'redirect') navigate(event.redirectTo);
        else setDenied(true);
      }),
    [navigate],
  );

  return { denied };
}
