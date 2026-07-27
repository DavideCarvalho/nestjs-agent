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
}

/** Resolved, validated `dashboardAuth` config used by the guards/controller. */
export interface ResolvedDashboardAuth {
  secret: string;
  ttlMs: number;
  modes: AuthMode[];
  session?: SessionHook;
  login?: LoginHook;
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
  };
}
