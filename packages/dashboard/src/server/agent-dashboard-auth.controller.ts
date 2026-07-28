import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { parseCookieHeader } from './auth/cookie-header.js';
import type { ResolvedDashboardAuth } from './auth/dashboard-auth-config.js';
import { readCookieHeader } from './auth/http-request.js';
import { renderLoginPage, renderSessionRequiredPage } from './auth/login-page.js';
import { sanitizeReturnTo } from './auth/sanitize-return-to.js';
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  issueSessionCookie,
} from './auth/session-cookie-io.js';
import { type DashboardSessionUser, verifySessionCookie } from './auth/session-cookie.js';
import { DASHBOARD_AUTH, DASHBOARD_BASE_PATH } from './tokens.js';

/** The slice of the platform request this controller reads — structural, no Express/Fastify dependency. */
interface AuthPageRequest {
  headers: Record<string, string | string[] | undefined>;
}

/** The slice of the platform response this controller writes (passthrough mode — Nest still sends). */
interface AuthPageResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

interface LoginFormBody {
  username?: unknown;
  password?: unknown;
  returnTo?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Mounted directly on `AgentDashboardModule` at `<basePath>/auth/*` — a SEPARATE controller from
 * `AgentUiController`/`AgentApiController` so it carries neither `DashboardAuthPageGuard`,
 * `DashboardAuthGuard`, nor any host `guards`: these routes MINT (and clear) the session cookie the
 * built-in gates check for, so they can never be made to require the very auth they grant. Mirrors
 * `@dudousxd/nestjs-telescope`'s own auth controller staying outside its `stampGuards` call.
 *
 * Two ways to mint that cookie, matching `resolveDashboardAuth`'s modes: Mode A (`session`) — the
 * host frontend, already carrying its own auth, POSTs to `<basePath>/auth/session` and the host
 * hook decides — or Mode B (`login`), a dependency-free, server-rendered login form (GET/POST) —
 * the bundled React SPA in this package is a built Vite artifact with no auth-aware UI of its own,
 * so gating the actual page navigation needs a self-contained flow that doesn't touch it. Each
 * mode's routes 404 when that mode isn't listed in `auth.modes` — the single source of truth for
 * which mode(s) are configured, not hook-presence truthiness — and every route 404s outright when
 * `dashboardAuth` is unconfigured (`DASHBOARD_AUTH` resolves to `null`) — no dangling login page
 * when the feature is off.
 */
@Controller('auth')
export class AgentDashboardAuthController {
  private readonly logger = new Logger(AgentDashboardAuthController.name);
  /** Warn once PER HOOK KIND (not per request) so a broken hook can't be used to flood the logs. */
  private readonly warnedHooks = new Set<string>();

  constructor(
    @Optional() @Inject(DASHBOARD_AUTH) private readonly auth: ResolvedDashboardAuth | null,
    @Inject(DASHBOARD_BASE_PATH) private readonly basePath: string,
  ) {}

  @Get('login')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  loginPage(
    @Req() req: AuthPageRequest,
    @Res({ passthrough: true }) res: AuthPageResponse,
    @Query('returnTo') returnToQuery?: string,
    @Query('error') error?: string,
  ): string {
    const auth = this.requireAuth();
    // Mode A only: no login screen exists — the host mints the session.
    if (!auth.modes.includes('login')) throw new NotFoundException();
    const returnTo = sanitizeReturnTo(this.basePath, returnToQuery);
    // Already signed in — a fresh GET (e.g. a bookmarked login URL) just goes back in, no need to
    // re-prompt for credentials.
    if (this.currentSession(req)) {
      res.status(302);
      res.setHeader('Location', returnTo);
      return '';
    }
    return renderLoginPage({
      actionUrl: `${this.basePath}/auth/login`,
      returnTo,
      error: error !== undefined,
    });
  }

  @Post('login')
  async login(
    @Body() body: LoginFormBody,
    @Req() req: unknown,
    @Res({ passthrough: true }) res: AuthPageResponse,
  ): Promise<string> {
    const auth = this.requireAuth();
    if (!auth.modes.includes('login')) throw new NotFoundException();
    const returnTo = sanitizeReturnTo(this.basePath, body?.returnTo);
    const username = body?.username;
    const password = body?.password;
    // Username is required (non-empty, trimmed). Password is OPTIONAL end-to-end: it reaches the
    // host `login` hook AS-IS — `''` when blank/omitted — because some hosts gate on username
    // alone (e.g. flip: email must belong to an active ADMIN, password deliberately ignored). Only
    // reject here on a malformed shape (password present but not a string), never on emptiness.
    if (!isNonEmptyString(username) || (password !== undefined && !isString(password))) {
      this.redirectToLoginError(res, returnTo);
      return '';
    }
    const user = await this.runHook(
      'login',
      () => auth.login?.(username.trim(), isString(password) ? password : '') ?? null,
    );
    if (!user) {
      this.redirectToLoginError(res, returnTo);
      return '';
    }
    issueSessionCookie(user, { auth, request: req, response: res });
    res.status(302);
    res.setHeader('Location', returnTo);
    return '';
  }

  @Post('logout')
  logout(@Req() req: unknown, @Res({ passthrough: true }) res: AuthPageResponse): string {
    // Best-effort: clearing is harmless even without dashboardAuth configured.
    clearSessionCookie({ request: req, response: res });
    res.status(302);
    // Runs WITHOUT requireAuth() (logout must succeed even when auth is off/misconfigured), so
    // read `this.auth?.login` directly rather than calling it. Mirrors `DashboardAuthPageGuard`'s
    // `deny()` mode check: Mode-A-only has no login screen to land on (`loginPage` above 404s
    // under Mode A), so bounce to the instruction page instead. When `dashboardAuth` isn't
    // configured at all, `this.auth` is `null` and today's target is preserved unchanged.
    res.setHeader(
      'Location',
      this.auth && !this.auth.modes.includes('login')
        ? `${this.basePath}/auth/session-required`
        : `${this.basePath}/auth/login`,
    );
    return '';
  }

  // Mode A: the host frontend (carrying its own auth) POSTs here; the host hook validates the raw
  // request and returns the session user, or `null` to deny. No credential reaches this library.
  @Post('session')
  @HttpCode(204)
  async session(
    @Req() request: unknown,
    @Res({ passthrough: true }) response: unknown,
  ): Promise<void> {
    const auth = this.requireAuth();
    if (!auth.modes.includes('session')) throw new NotFoundException();
    const user = await this.runHook('session', () => auth.session?.(request) ?? null);
    if (!user) throw new UnauthorizedException();
    issueSessionCookie(user, { auth, request, response });
  }

  // Mode-A-only landing: the host mints the session, so there is nothing to submit here. Serves
  // as the redirect target `DashboardAuthPageGuard` bounces to instead of `/auth/login`, which
  // 404s under Mode A (see `loginPage` above).
  @Get('session-required')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store, must-revalidate')
  sessionRequiredPage(): string {
    const auth = this.requireAuth();
    if (auth.modes.includes('login')) throw new NotFoundException();
    return renderSessionRequiredPage();
  }

  /** Uniform failure: same redirect (generic error flag) whether the user is unknown or the password is wrong. */
  private redirectToLoginError(res: AuthPageResponse, returnTo: string): void {
    res.status(303);
    res.setHeader(
      'Location',
      `${this.basePath}/auth/login?error=1&returnTo=${encodeURIComponent(returnTo)}`,
    );
  }

  private currentSession(req: AuthPageRequest): boolean {
    const auth = this.auth;
    if (!auth) return false;
    const cookieValue = parseCookieHeader(readCookieHeader(req))[SESSION_COOKIE_NAME];
    if (cookieValue === undefined) return false;
    return verifySessionCookie(cookieValue, { secret: auth.secret }) !== null;
  }

  /**
   * Run a host hook (`login` or `session`) defensively: a throw (sync or async) is treated as a
   * denial (`null`) and warn-logged ONCE PER KIND, so a buggy/unreachable hook never 500s the
   * endpoint into a stack-trace leak nor floods the logs on repeated bad attempts.
   */
  private async runHook(
    kind: string,
    run: () => Promise<DashboardSessionUser | null> | DashboardSessionUser | null,
  ): Promise<DashboardSessionUser | null> {
    try {
      return (await run()) ?? null;
    } catch (error) {
      if (!this.warnedHooks.has(kind)) {
        this.warnedHooks.add(kind);
        this.logger.warn(
          `AgentDashboardModule dashboardAuth ${kind} hook threw; treating as denial. ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return null;
    }
  }

  private requireAuth(): ResolvedDashboardAuth {
    // The auth controller only does anything useful when dashboardAuth is configured — a
    // defensive 404 rather than a reachable runtime path for a properly-wired module.
    if (!this.auth) throw new NotFoundException();
    return this.auth;
  }
}
