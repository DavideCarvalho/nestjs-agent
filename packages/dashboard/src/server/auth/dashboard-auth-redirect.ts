// packages/dashboard/src/server/auth/dashboard-auth-redirect.ts
import { type ArgumentsHost, Catch, type ExceptionFilter, Injectable } from '@nestjs/common';
import { sendRedirect } from './response.js';

/**
 * Thrown by `DashboardAuthPageGuard` to deny an unauthenticated PAGE navigation with a 302 to the
 * login screen — deliberately NOT an `HttpException`: a guard returning `false` makes Nest send
 * its OWN 403 body, which would clobber a `Location` header set beforehand. Throwing this instead
 * routes through `DashboardAuthRedirectFilter` below, which owns the entire response.
 */
export class DashboardAuthRedirect extends Error {
  constructor(readonly redirectTo: string) {
    super(`Redirect to ${redirectTo}`);
    this.name = 'DashboardAuthRedirect';
  }
}

/**
 * Turns a thrown {@link DashboardAuthRedirect} into an actual 302 response. Scoped directly onto
 * `AgentUiController` via `@UseFilters(new DashboardAuthRedirectFilter())` — harmless when
 * `dashboardAuth` is unconfigured, since the guard never throws this exception in that case.
 */
@Injectable()
@Catch(DashboardAuthRedirect)
export class DashboardAuthRedirectFilter implements ExceptionFilter<DashboardAuthRedirect> {
  catch(exception: DashboardAuthRedirect, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<unknown>();
    sendRedirect(response, 302, exception.redirectTo);
  }
}
