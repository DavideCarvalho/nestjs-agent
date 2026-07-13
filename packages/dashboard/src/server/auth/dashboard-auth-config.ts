// packages/dashboard/src/server/auth/dashboard-auth-config.ts
import type { DashboardSessionUser } from './session-cookie.js';

/** Host hook: validates submitted credentials for the built-in login screen. */
export type LoginHook = (
  username: string,
  password: string,
) => Promise<DashboardSessionUser | null> | DashboardSessionUser | null;

/**
 * Author-facing `dashboardAuth` option (see `AgentDashboardOptions.dashboardAuth`). Gates the
 * console (SPA + API) behind a built-in cookie-session login screen — no host frontend changes,
 * no SSO required. Mirrors `@dudousxd/nestjs-telescope`'s `dashboardAuth` Mode B (`login`).
 */
export interface DashboardAuthOptions {
  /** REQUIRED HMAC-SHA256 signing key (32+ bytes recommended). Missing/empty => boot error (fail closed). */
  secret: string;
  /** Cookie TTL (duration string `'<n><ms|s|m|h|d>'`, e.g. `'30m'`, `'7d'`). Default `'8h'`. */
  ttl?: string;
  /**
   * Validates submitted username/password. Return the session user to grant access, or `null` to
   * deny — the login endpoint responds identically (generic failure) for an unknown user and a
   * wrong password, so it never reveals which one was wrong.
   */
  login: LoginHook;
}

/** Resolved, validated `dashboardAuth` config used by the guards/controller. */
export interface ResolvedDashboardAuth {
  secret: string;
  ttlMs: number;
  login: LoginHook;
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
 * configured but missing a secret or a `login` hook — the host learns immediately rather than
 * shipping an open or un-mintable console.
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
  if (typeof options.login !== 'function') {
    throw new Error(
      'AgentDashboardModule dashboardAuth: `login` is required (validates submitted credentials ' +
        'for the built-in login screen). Failing closed.',
    );
  }
  return {
    secret: options.secret,
    ttlMs: durationToMs(options.ttl ?? DEFAULT_TTL),
    login: options.login,
  };
}
