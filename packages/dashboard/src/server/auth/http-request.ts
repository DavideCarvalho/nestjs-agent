// packages/dashboard/src/server/auth/http-request.ts
import type { DashboardSession } from './session-cookie.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readHeaders(request: unknown): Record<string, unknown> {
  if (!isRecord(request)) return {};
  const headers = request.headers;
  return isRecord(headers) ? headers : {};
}

/** Coerce a single header (string or string[]) to a string, else undefined. */
function headerToString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    return value.join(',');
  }
  return undefined;
}

/** Read the raw `Cookie` request header (Express and Fastify both expose `headers`). */
export function readCookieHeader(request: unknown): string | undefined {
  return headerToString(readHeaders(request).cookie);
}

/**
 * Decide whether the cookie should carry `Secure`. True when the request is https directly
 * (`request.protocol === 'https'`) OR a proxy forwarded https (`x-forwarded-proto` includes
 * 'https'). Defensive structural reads — never throws, defaults to insecure (works on plain http
 * in dev).
 */
export function isHttpsRequest(request: unknown): boolean {
  if (isRecord(request) && request.protocol === 'https') return true;
  const forwarded = headerToString(readHeaders(request)['x-forwarded-proto']);
  if (forwarded === undefined) return false;
  return forwarded
    .split(',')
    .map((proto) => proto.trim().toLowerCase())
    .includes('https');
}

/** The original path + query as received (Express `originalUrl` / Fastify `url`). */
export function readOriginalUrl(request: unknown): string {
  if (!isRecord(request)) return '/';
  const originalUrl = request.originalUrl;
  if (typeof originalUrl === 'string' && originalUrl !== '') return originalUrl;
  const url = request.url;
  return typeof url === 'string' && url !== '' ? url : '/';
}

/** A request with the verified session attached for downstream reads. */
export interface RequestWithSession {
  dashboardSession: DashboardSession;
}

/**
 * Attach the verified session onto the raw request so downstream handlers can read
 * `request.dashboardSession`. Narrow structural mutation — avoids an `as` cast at the guard call
 * site.
 */
export function attachSession(request: unknown, session: DashboardSession): void {
  if (!isRecord(request)) return;
  const target: Partial<RequestWithSession> = request;
  target.dashboardSession = session;
}
