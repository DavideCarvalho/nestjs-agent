// packages/dashboard/src/server/auth/sanitize-return-to.ts

/**
 * Validate a client-supplied `returnTo` so the login flow can never be turned into an open
 * redirect: it must be a same-origin path (no scheme, no `//host` prefix) that stays within
 * `basePath`. Anything else — absent, a protocol-relative URL, a foreign path — falls back to
 * `basePath` itself.
 */
export function sanitizeReturnTo(basePath: string, returnTo: unknown): string {
  if (typeof returnTo !== 'string' || returnTo === '') return basePath;
  // Reject anything that isn't a plain same-origin path: no scheme (`http:`), no
  // protocol-relative prefix (`//evil.com`), must start with `/`.
  if (!returnTo.startsWith('/') || returnTo.startsWith('//')) return basePath;
  if (
    returnTo !== basePath &&
    !returnTo.startsWith(`${basePath}/`) &&
    !returnTo.startsWith(`${basePath}?`)
  ) {
    return basePath;
  }
  return returnTo;
}
