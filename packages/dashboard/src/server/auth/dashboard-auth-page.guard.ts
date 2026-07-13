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
import { SESSION_COOKIE_NAME, issueSessionCookie } from './session-cookie-io.js';
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

  canActivate(context: ExecutionContext): boolean {
    if (!this.auth) return true;
    const http = context.switchToHttp();
    const request = http.getRequest<unknown>();
    const session = this.verifyRequestSession(request);
    if (!session) {
      const returnTo = readOriginalUrl(request);
      throw new DashboardAuthRedirect(
        `${this.basePath}/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
      );
    }
    attachSession(request, session);
    this.maybeRenew(http.getResponse<unknown>(), request, session);
    return true;
  }

  private verifyRequestSession(request: unknown): DashboardSession | null {
    const auth = this.auth;
    if (!auth) return null;
    const cookieValue = parseCookieHeader(readCookieHeader(request))[SESSION_COOKIE_NAME];
    if (cookieValue === undefined) return null;
    return verifySessionCookie(cookieValue, { secret: auth.secret });
  }

  /**
   * Sliding renewal: a valid cookie past 50% of its TTL is transparently re-issued on the
   * response, so an active user never gets logged out mid-session.
   */
  private maybeRenew(response: unknown, request: unknown, session: DashboardSession): void {
    const auth = this.auth;
    if (!auth) return;
    const now = Date.now();
    if (now - session.iat <= auth.ttlMs / 2) return;
    issueSessionCookie(
      {
        id: session.sub,
        ...(session.name !== undefined ? { name: session.name } : {}),
        roles: session.roles,
      },
      { auth, request, response, now },
    );
  }
}
