// packages/dashboard/src/server/auth/dashboard-auth.guard.ts
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { DASHBOARD_AUTH } from '../tokens.js';
import { parseCookieHeader } from './cookie-header.js';
import type { ResolvedDashboardAuth } from './dashboard-auth-config.js';
import { attachSession, readCookieHeader } from './http-request.js';
import { SESSION_COOKIE_NAME, issueSessionCookie } from './session-cookie-io.js';
import { type DashboardSession, verifySessionCookie } from './session-cookie.js';

/**
 * Gates `AgentApiController` on a valid session cookie — but ONLY when the host configured
 * `dashboardAuth`. With no `dashboardAuth` the resolved value is `null` and the guard is a no-op
 * (today's behavior byte-for-byte; the API stays open, front it with your own `guards`). Composes
 * with host `guards` via `stampGuards`'s APPEND semantics (see `../guards.ts`) — AND semantics,
 * both gates must pass.
 *
 * Absent/invalid/expired cookie => `401` (not `403`): "not authenticated", distinct from a host
 * guard's `403` "authenticated, not allowed".
 */
@Injectable()
export class DashboardAuthGuard implements CanActivate {
  constructor(
    @Optional() @Inject(DASHBOARD_AUTH) private readonly auth: ResolvedDashboardAuth | null,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.auth) return true;
    const http = context.switchToHttp();
    const request = http.getRequest<unknown>();
    const session = this.verifyRequestSession(request);
    if (!session) throw new UnauthorizedException();
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
