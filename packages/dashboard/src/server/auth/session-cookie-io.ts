import { serializeSetCookie } from './cookie-header.js';
// packages/dashboard/src/server/auth/session-cookie-io.ts
import type { ResolvedDashboardAuth } from './dashboard-auth-config.js';
import { isHttpsRequest } from './http-request.js';
import { appendSetCookie } from './response.js';
import { type DashboardSessionUser, signSessionCookie } from './session-cookie.js';

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
