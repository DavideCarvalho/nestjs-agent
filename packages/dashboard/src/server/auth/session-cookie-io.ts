import { serializeSetCookie } from './cookie-header.js';
// packages/dashboard/src/server/auth/session-cookie-io.ts
import type { ResolvedDashboardAuth } from './dashboard-auth-config.js';
import { isHttpsRequest } from './http-request.js';
import { appendSetCookie } from './response.js';
import {
  type DashboardSession,
  type DashboardSessionUser,
  signSessionCookie,
} from './session-cookie.js';

/** Cookie name carrying the signed dashboard session. */
export const SESSION_COOKIE_NAME = 'agent_dashboard_session';

/**
 * Cookie `Path`. Unlike `@dudousxd/nestjs-telescope` (UI + API always share one mount root, so its
 * cookie scopes to that root), this dashboard supports an `apiBasePath` configured OUTSIDE
 * `basePath` (e.g. `/api/ai-gateway` alongside a `/ai-gateway` UI) — a path scoped to `basePath`
 * would never ride to a separately-mounted API. `Path=/` is the only scoping that is correct for
 * every mount configuration; `HttpOnly` + `SameSite=Lax` already do the real security work.
 */
const COOKIE_PATH = '/';

/**
 * Sign a fresh session for `user` and append it as a `Set-Cookie` on the response, `Secure` when
 * the request is https.
 */
export function issueSessionCookie(
  user: DashboardSessionUser,
  context: {
    auth: ResolvedDashboardAuth;
    request: unknown;
    response: unknown;
    now?: number;
  },
): void {
  const value = signSessionCookie(user, {
    secret: context.auth.secret,
    ttlMs: context.auth.ttlMs,
    ...(context.now !== undefined ? { now: context.now } : {}),
  });
  const cookie = serializeSetCookie(SESSION_COOKIE_NAME, value, {
    path: COOKIE_PATH,
    maxAgeSeconds: Math.floor(context.auth.ttlMs / 1000),
    secure: isHttpsRequest(context.request),
  });
  appendSetCookie(context.response, cookie);
}

/** Append a cookie-clearing `Set-Cookie` (Max-Age=0). */
export function clearSessionCookie(context: { request: unknown; response: unknown }): void {
  const cookie = serializeSetCookie(SESSION_COOKIE_NAME, '', {
    path: COOKIE_PATH,
    maxAgeSeconds: 0,
    secure: isHttpsRequest(context.request),
    clear: true,
  });
  appendSetCookie(context.response, cookie);
}

/**
 * In-flight `revalidate()` calls, keyed by session identity (`sub:iat` — the exact cookie
 * generation), so concurrent requests carrying the same not-yet-renewed cookie share ONE host
 * round-trip instead of each starting their own. Entries are removed as soon as they settle (see
 * `getOrStartRevalidation`), so this never accumulates beyond "sessions currently mid-revalidation"
 * — bounded by concurrent in-flight requests, not by session count over time.
 */
const inFlightRevalidations = new Map<string, Promise<boolean>>();

/** The exact cookie generation being revalidated — a renewal mints a new `iat`, so this can't
 *  collide across generations of the same user's session. */
function revalidationKey(session: DashboardSession): string {
  return `${session.sub}:${session.iat}`;
}

/**
 * Runs (or joins an already-running) `revalidate` call for this exact session. Cleans up on BOTH
 * resolve and reject (`finally`) so a rejecting/throwing hook can't wedge the session behind a
 * dead cached promise — the next call after a failure reaches the host again, not a stale rejection.
 */
function getOrStartRevalidation(
  auth: ResolvedDashboardAuth,
  session: DashboardSession,
  user: DashboardSessionUser,
): Promise<boolean> {
  const hook = auth.revalidate;
  if (!hook) return Promise.resolve(true);
  const key = revalidationKey(session);
  const inFlight = inFlightRevalidations.get(key);
  if (inFlight) return inFlight;
  const outcome = (async () => {
    try {
      return await hook(user);
    } catch {
      // Fail closed: a throwing hook revokes rather than silently extending the session.
      return false;
    }
  })().finally(() => {
    inFlightRevalidations.delete(key);
  });
  inFlightRevalidations.set(key, outcome);
  return outcome;
}

/**
 * Sliding renewal + revalidation. When a valid cookie is past 50% of its TTL, re-issue a fresh one
 * so an active session never expires mid-use — but first give the host's `revalidate` hook a say,
 * so a deactivated or demoted user loses access instead of riding a self-renewing cookie forever.
 *
 * Concurrent requests carrying the same past-half-life cookie share ONE `revalidate` call (see
 * `getOrStartRevalidation`) — a page load firing N parallel API calls costs the host one round-trip,
 * not N, matching `RevalidateHook`'s documented "at most once per `ttl/2`" cost. Each caller still
 * gets its own `Set-Cookie` written to its own response; only the host round-trip is shared.
 *
 * Returns `false` when the session was revoked (the clearing `Set-Cookie` is already queued and the
 * caller must deny the request); `true` otherwise, including when no renewal was due.
 */
export async function maybeRenewSession(
  auth: ResolvedDashboardAuth,
  session: DashboardSession,
  request: unknown,
  response: unknown,
  now: number = Date.now(),
): Promise<boolean> {
  if (now - session.iat <= auth.ttlMs / 2) return true;
  const user: DashboardSessionUser = {
    id: session.sub,
    ...(session.name !== undefined ? { name: session.name } : {}),
    roles: session.roles,
  };
  const allowed = await getOrStartRevalidation(auth, session, user);
  if (!allowed) {
    clearSessionCookie({ request, response });
    return false;
  }
  issueSessionCookie(user, { auth, request, response, now });
  return true;
}
