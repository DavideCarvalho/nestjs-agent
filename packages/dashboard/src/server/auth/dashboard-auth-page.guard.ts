// packages/dashboard/src/server/auth/dashboard-auth-page.guard.ts
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { DASHBOARD_AUTH, DASHBOARD_BASE_PATH } from '../tokens.js';
import { parseCookieHeader } from './cookie-header.js';
import type { ResolvedDashboardAuth } from './dashboard-auth-config.js';
import { DashboardAuthRedirect } from './dashboard-auth-redirect.js';
import { attachSession, readCookieHeader, readOriginalUrl } from './http-request.js';
import { SESSION_COOKIE_NAME, maybeRenewSession } from './session-cookie-io.js';
import { type DashboardSession, verifySessionCookie } from './session-cookie.js';

/**
 * Gates `AgentUiController` (the page + its assets) on a valid session cookie — but ONLY when the
 * host configured `dashboardAuth`. With no `dashboardAuth` the resolved value is `null` and the
 * guard is a no-op (today's behavior byte-for-byte). Composes with host `guards` via
 * `stampGuards`'s APPEND semantics (see `../guards.ts`) — AND semantics, both gates must pass.
 *
 * Unlike {@link DashboardAuthGuard} (the API's `401`), a denied PAGE navigation throws
 * {@link DashboardAuthRedirect} — a browser hitting a protected URL gets bounced to the built-in
 * login screen (with a `returnTo` back to the page it came from) rather than a bare JSON 401.
 */
@Injectable()
export class DashboardAuthPageGuard implements CanActivate {
  constructor(
    @Optional() @Inject(DASHBOARD_AUTH) private readonly auth: ResolvedDashboardAuth | null,
    @Inject(DASHBOARD_BASE_PATH) private readonly basePath: string,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.auth) return true;
    const auth = this.auth;
    const http = context.switchToHttp();
    const request = http.getRequest<unknown>();
    const session = this.verifyRequestSession(request);
    if (!session) this.deny(auth, request);
    attachSession(request, session);
    if (!(await maybeRenewSession(auth, session, request, http.getResponse<unknown>()))) {
      // Revoked mid-session: same Mode-aware treatment as an absent cookie.
      this.deny(auth, request);
    }
    return true;
  }

  /**
   * No valid session: bounce the browser navigation onward. Under Mode B (`login` configured)
   * that's the built-in login screen, carrying `returnTo` back to the page that was requested.
   * Under Mode-A-only there is no login screen to redirect to — the host mints the session
   * itself — so this instead serves the instruction page rather than redirecting into a 404.
   * Pulled out of `canActivate` so both the "no session at all" and the "revalidate revoked a
   * renewable session" paths reuse the exact same mode-aware deny logic.
   *
   * Takes `auth` explicitly rather than reading `this.auth`: `canActivate`'s `!this.auth` early
   * return narrows the field within that method only — TS doesn't carry it across a method call —
   * so the caller passes the already-narrowed value instead of this method re-deriving (or
   * asserting away) the nullability.
   */
  private deny(auth: ResolvedDashboardAuth, request: unknown): never {
    if (!auth.login) {
      throw new DashboardAuthRedirect(`${this.basePath}/auth/session-required`);
    }
    const returnTo = readOriginalUrl(request);
    throw new DashboardAuthRedirect(
      `${this.basePath}/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
    );
  }

  private verifyRequestSession(request: unknown): DashboardSession | null {
    const auth = this.auth;
    if (!auth) return null;
    const cookieValue = parseCookieHeader(readCookieHeader(request))[SESSION_COOKIE_NAME];
    if (cookieValue === undefined) return null;
    return verifySessionCookie(cookieValue, { secret: auth.secret });
  }
}
