// packages/dashboard/src/server/auth/response.ts

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface HeaderCapableResponse {
  getHeader(name: string): number | string | string[] | undefined;
  setHeader(name: string, value: string | string[]): unknown;
}

function isHeaderCapableResponse(value: unknown): value is HeaderCapableResponse {
  return (
    isRecord(value) &&
    typeof value.getHeader === 'function' &&
    typeof value.setHeader === 'function'
  );
}

/**
 * Resolve the header-capable response from a platform response. Express' response IS the Node
 * response; Fastify's reply wraps it on `.raw`. Returns the outer response when it already exposes
 * get/setHeader (Express), otherwise the unwrapped `.raw` (Fastify) — so a single write path serves
 * both. Only requires get/setHeader (not `end`) so it also works against a passthrough-mode
 * response, which Nest still owns sending.
 */
function resolveHeaderCapableResponse(response: unknown): HeaderCapableResponse | null {
  if (isHeaderCapableResponse(response)) return response;
  if (isRecord(response) && isHeaderCapableResponse(response.raw)) return response.raw;
  return null;
}

function existingSetCookies(response: HeaderCapableResponse): string[] {
  const current = response.getHeader('set-cookie');
  if (Array.isArray(current)) return current;
  if (typeof current === 'string') return [current];
  return [];
}

/**
 * Append a `Set-Cookie` header to the response WITHOUT clobbering any cookies already queued by
 * the host (auth or otherwise). Platform-agnostic raw write — no-ops gracefully if the response
 * can't be unwrapped.
 */
export function appendSetCookie(response: unknown, cookie: string): void {
  const raw = resolveHeaderCapableResponse(response);
  if (!raw) return;
  raw.setHeader('set-cookie', [...existingSetCookies(raw), cookie]);
}

interface RawNodeResponse extends HeaderCapableResponse {
  statusCode: number;
  end(chunk?: string): unknown;
}

function isRawNodeResponse(value: unknown): value is RawNodeResponse {
  return (
    isRecord(value) &&
    typeof value.getHeader === 'function' &&
    typeof value.setHeader === 'function' &&
    typeof value.end === 'function'
  );
}

function resolveRawResponse(response: unknown): RawNodeResponse | null {
  if (isRawNodeResponse(response)) return response;
  if (isRecord(response) && isRawNodeResponse(response.raw)) return response.raw;
  return null;
}

/**
 * Fully send a redirect response (status + `Location` + end the response) — used by the guard's
 * exception-filter path, which owns the ENTIRE response (unlike a passthrough controller handler
 * that can just set headers and return a body for Nest to send). No-ops gracefully if the
 * response can't be unwrapped.
 */
export function sendRedirect(response: unknown, status: number, location: string): void {
  const raw = resolveRawResponse(response);
  if (!raw) return;
  raw.statusCode = status;
  raw.setHeader('location', location);
  raw.end();
}
