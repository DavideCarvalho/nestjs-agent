// packages/dashboard/src/server/auth/dashboard-auth-config.ts
import type { DashboardSessionUser } from './session-cookie.js';

/**
 * Host hook for Mode A: validates the host's own auth on the raw request POSTed to
 * `<basePath>/auth/session`. Return the session user to grant access, or `null` to deny.
 */
export type SessionHook = (
  request: unknown,
) => Promise<DashboardSessionUser | null> | DashboardSessionUser | null;

/** Host hook for Mode B: validates submitted credentials for the built-in login screen. */
export type LoginHook = (
  username: string,
  password: string,
) => Promise<DashboardSessionUser | null> | DashboardSessionUser | null;

/**
 * Re-checks a LIVE session when the cookie is slid forward. Runs at most once per `ttl/2` PER
 * COOKIE GENERATION — the gate is on the inbound cookie's `iat`, so every request still carrying a
 * not-yet-renewed cookie would, on its own, invoke this hook again; `maybeRenewSession` de-dupes
 * concurrent calls for the same session (`sub` + `iat`) into a single in-flight call, so a page
 * load that fires N parallel API calls still costs exactly ONE host round-trip, not N. Still not a
 * per-session-lifetime cap — this can run again every `ttl/2` as the session keeps sliding, so a
 * slow or expensive check should still debounce/cache across renewal windows on its own. Return
 * `false` to revoke (the cookie is cleared and the request denied). Distinct from `session`: that
 * hook reads the host's auth off a fresh request, which a console XHR does not carry — this one
 * receives the already-minted session.
 */
export type RevalidateHook = (session: DashboardSessionUser) => Promise<boolean> | boolean;

/** What `unauthenticatedPage` receives. An object (not positional args) so fields can be added later. */
export interface UnauthenticatedPageContext {
  /**
   * The platform-native request — Express' `Request`, Fastify's `FastifyRequest`. Typed `unknown`
   * for the same reason `SessionHook`'s is: this package refuses to depend on either platform.
   * Cast it to whatever your app actually runs on.
   */
  request: unknown;
  /**
   * The platform-native response. The hook OWNS it: it must write AND end it (`res.render(...)`,
   * `res.status(401).send(...)`, an Inertia render, ...). If the hook returns without writing, the
   * library falls back to its own built-in page rather than leaving the request hanging.
   */
  response: unknown;
  /** Where this console is mounted (e.g. `/ai-gateway`) — useful for a "back to the console" link. */
  basePath: string;
}

/**
 * Host-owned page for an unauthenticated navigation to the console.
 *
 * The built-in page cannot know who hosts the console, so it can only say "open this console from
 * your application" in the abstract — it can't name the launcher, link to it, or look like the rest
 * of the host's product. This hook hands the whole response to the host instead: render through
 * your own template engine, your own Inertia page, whatever.
 *
 * Served at `<basePath>/auth/session-required`, which is where `DashboardAuthPageGuard` already
 * redirects a denied Mode-A navigation today — this hook changes what that page CONTAINS, not the
 * flow that reaches it.
 *
 * Deliberately NOT a replacement for Mode B's built-in login form. A host that wants its own login
 * UI uses Mode A plus this hook, and posts to `<basePath>/auth/session` from its own page — the
 * mint endpoint is the supported primitive for that.
 *
 * Fail-closed by construction: it only ever runs on a request that has ALREADY been denied. A hook
 * that throws, or that returns without writing, falls back to the built-in page — it cannot let
 * anyone in.
 */
export type UnauthenticatedPageHook = (context: UnauthenticatedPageContext) => void | Promise<void>;

/** Which `dashboardAuth` hook(s) a resolved config was given — see `resolveDashboardAuth`. */
export type AuthMode = 'session' | 'login';

/**
 * Author-facing `dashboardAuth` option (see `AgentDashboardOptions.dashboardAuth`). Gates the
 * console (SPA + API) behind a signed session cookie. Two ways to mint that cookie: Mode A
 * (`session`) — the host frontend, already carrying its own auth, POSTs to
 * `<basePath>/auth/session` and the host hook decides — or Mode B (`login`) — the built-in,
 * dependency-free server-rendered login screen. Mirrors `@dudousxd/nestjs-telescope`'s
 * `dashboardAuth` two-mode shape. At least one of the two is required so an un-mintable gate is a
 * boot error, not a silently-open (or silently-stuck) console.
 */
export interface DashboardAuthOptions {
  /** REQUIRED HMAC-SHA256 signing key (32+ bytes recommended). Missing/empty => boot error (fail closed). */
  secret: string;
  /** Cookie TTL (duration string `'<n><ms|s|m|h|d>'`, e.g. `'30m'`, `'7d'`). Default `'8h'`. */
  ttl?: string;
  /**
   * Mode A: validates the host's own auth on the raw request POSTed to `<basePath>/auth/session`.
   * Return the session user to grant access, or `null` to deny. No credential reaches this
   * library — the host decides from whatever it already has (a header, an SSO cookie, ...).
   */
  session?: SessionHook;
  /**
   * Mode B: validates submitted username/password. Return the session user to grant access, or
   * `null` to deny — the login endpoint responds identically (generic failure) for an unknown user
   * and a wrong password, so it never reveals which one was wrong.
   */
  login?: LoginHook;
  /** Re-checks a live session on sliding renewal; see `RevalidateHook`. Not a mode — it cannot
   *  mint a session, only revoke one already minted by `session`/`login`. */
  revalidate?: RevalidateHook;
  /** Renders the host's own page for an unauthenticated navigation, in place of the built-in
   *  "open this console from your application" card; see `UnauthenticatedPageHook`. */
  unauthenticatedPage?: UnauthenticatedPageHook;
}

/** Resolved, validated `dashboardAuth` config used by the guards/controller. */
export interface ResolvedDashboardAuth {
  secret: string;
  ttlMs: number;
  modes: AuthMode[];
  session?: SessionHook;
  login?: LoginHook;
  revalidate?: RevalidateHook;
  unauthenticatedPage?: UnauthenticatedPageHook;
}

const DEFAULT_TTL = '8h';

/** Unit → ms multiplier. A `switch` (not an indexed lookup) so no cast is needed to narrow the regex capture. */
function unitToMs(unit: string): number | undefined {
  switch (unit) {
    case 'ms':
      return 1;
    case 's':
      return 1_000;
    case 'm':
      return 60_000;
    case 'h':
      return 3_600_000;
    case 'd':
      return 86_400_000;
    default:
      return undefined;
  }
}

/** Convert a `'<int><ms|s|m|h|d>'` duration string to ms. Throws on an unparseable string. */
function durationToMs(duration: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(duration.trim());
  const amount = match?.[1];
  const unit = match?.[2] !== undefined ? unitToMs(match[2]) : undefined;
  if (amount === undefined || unit === undefined) {
    throw new Error(`AgentDashboardModule dashboardAuth: invalid \`ttl\` duration: ${duration}`);
  }
  return Number(amount) * unit;
}

/**
 * Validate + resolve `dashboardAuth`. Returns `null` when unconfigured (behavior unchanged — the
 * console stays open, front it with your own `guards`). Throws at boot (fail closed) when
 * configured but missing a secret, when neither `session` nor `login` is given, or when a given
 * hook isn't a function — the host learns immediately rather than shipping an open, stuck, or
 * un-mintable console.
 */
export function resolveDashboardAuth(
  options: DashboardAuthOptions | undefined,
): ResolvedDashboardAuth | null {
  if (options === undefined) return null;
  if (typeof options.secret !== 'string' || options.secret === '') {
    throw new Error(
      'AgentDashboardModule dashboardAuth: `secret` is required and must be a non-empty string ' +
        '(HMAC-SHA256 signing key, 32+ bytes recommended). Failing closed.',
    );
  }
  const modes: AuthMode[] = [];
  if (options.session !== undefined) {
    if (typeof options.session !== 'function') {
      throw new Error('AgentDashboardModule dashboardAuth: `session` must be a function.');
    }
    modes.push('session');
  }
  if (options.login !== undefined) {
    if (typeof options.login !== 'function') {
      throw new Error('AgentDashboardModule dashboardAuth: `login` must be a function.');
    }
    modes.push('login');
  }
  if (options.revalidate !== undefined && typeof options.revalidate !== 'function') {
    throw new Error('AgentDashboardModule dashboardAuth: `revalidate` must be a function.');
  }
  if (
    options.unauthenticatedPage !== undefined &&
    typeof options.unauthenticatedPage !== 'function'
  ) {
    throw new Error(
      'AgentDashboardModule dashboardAuth: `unauthenticatedPage` must be a function.',
    );
  }
  if (modes.length === 0) {
    throw new Error(
      'AgentDashboardModule dashboardAuth: at least one of `session` (the host mints the session ' +
        'from its own auth) or `login` (the built-in login screen) is required — otherwise the ' +
        'cookie can never be minted. Failing closed.',
    );
  }
  return {
    secret: options.secret,
    ttlMs: durationToMs(options.ttl ?? DEFAULT_TTL),
    modes,
    ...(options.session !== undefined ? { session: options.session } : {}),
    ...(options.login !== undefined ? { login: options.login } : {}),
    ...(options.revalidate !== undefined ? { revalidate: options.revalidate } : {}),
    ...(options.unauthenticatedPage !== undefined
      ? { unauthenticatedPage: options.unauthenticatedPage }
      : {}),
  };
}
