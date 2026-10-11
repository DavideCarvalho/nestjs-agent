/**
 * The global-slot contracts of Personal Agent Protocol ("Poppy") with an authorization server in the
 * same process (`@adonis-agora/authkit-server` installs into them): the Session Token resolver, the
 * announced issuer and the endpoints. Shared here so the Poppy package and the MCP server read the
 * same slots with the same types.
 */
import type { Actor } from '../types.js';

/**
 * Who a Poppy request comes from: a Personal Agent (`clientId`) acting for one of its Users
 * (`userId`, the pairwise User ID — not an account) in one Session. `signedIn`, with the app
 * account (`accountId`) and `scopes`, once the User signed in here (§4.4); a signed-out token has
 * neither. The shape `@adonis-agora/authkit-server` answers.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec),
 * a spec still in development: this API WILL change as the spec evolves — possibly in breaking
 * ways, outside semver majors while it is a draft.
 */
export interface PoppyPrincipal {
  /** The opaque, stable id the Personal Agent gave this User here. */
  userId: string;
  /** The app account, when the Session is signed in; `null` signed out. */
  accountId: string | null;
  /** The Personal Agent's `client_id` (its metadata document URL). */
  clientId: string;
  /** The token's account scopes (`poppy:read`, `poppy:write`, custom). Empty signed out. */
  scopes: string[];
  sessionId: string;
  signedIn: boolean;
  /** The `resource` the token was issued for (RFC 8707), or `null`. */
  resource?: string | null;
  tokenType?: 'DPoP' | 'Bearer';
  /** What the authorization server's `toActor` answered, when it has one. */
  actor?: Actor;
}

/** The request a resolver verifies — the Session Token and its DPoP proof are in `headers`. */
export interface PoppyAuthRequest {
  method: string;
  /** The full PUBLIC request URL (the DPoP `htu` is checked against it; the query is ignored). */
  url: string;
  /** The request's headers as received (lower-cased names) — `authorization` and `dpop` included. */
  headers: Record<string, string | string[] | undefined>;
}

/**
 * What a resolver may be asked to require besides a valid token. The conversation endpoint asks for
 * none: which scopes a turn needs is decided per tool, and the `resource` a token must carry is
 * derived by the resolver from the URL (the `resource` of the `poppy` protocol entry, if any).
 */
export interface PoppyAuthOptions {
  scopes?: string[];
  signedIn?: boolean;
  resource?: string | null;
}

export type PoppyAuthFailure = {
  ok: false;
  status: 400 | 401 | 403;
  error:
    | 'invalid_token'
    | 'sign_in_required'
    | 'insufficient_scope'
    | 'invalid_dpop_proof'
    | 'use_dpop_nonce'
    | (string & {});
  scope?: string;
  /** The challenge to answer with, verbatim. */
  wwwAuthenticate: string;
  /** For logs and the body's `error_description` — never the token. */
  description?: string;
  /** Extra headers to answer with (`DPoP-Nonce`). */
  headers?: Record<string, string>;
};

export type PoppyAuthResult = { ok: true; principal: PoppyPrincipal } | PoppyAuthFailure;

/**
 * Verifies a request's Session Token. An authorization server in the process installs one in the
 * global slot {@link POPPY_AUTHENTICATE_SLOT}; an app can pass its own
 * (`AgentPoppyModule.forRoot({ authenticate })`).
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec),
 * a spec still in development: this API WILL change as the spec evolves — possibly in breaking
 * ways, outside semver majors while it is a draft.
 */
export type PoppyAuthenticate = (
  request: PoppyAuthRequest,
  options?: PoppyAuthOptions,
) => Promise<PoppyAuthResult>;

/**
 * The contract with the authorization server is this global symbol, not a module: neither package
 * imports the other. Its name is the protocol contract `@adonis-agora/authkit-server` installs —
 * kept verbatim so the same authorization server serves Adonis and Nest apps alike.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec).
 */
export const POPPY_AUTHENTICATE_SLOT = Symbol.for('@adonis-agora/poppy:authenticate');

/** The global slot an authorization server announces its Poppy issuer in. */
export const POPPY_ISSUER_SLOT = Symbol.for('@adonis-agora/poppy:issuer');

/** The resolver installed in the global slot, if any — read per request, so install order is free. */
export function globalPoppyAuthenticate(): PoppyAuthenticate | undefined {
  const value = (globalThis as Record<symbol, unknown>)[POPPY_AUTHENTICATE_SLOT];
  return typeof value === 'function' ? (value as PoppyAuthenticate) : undefined;
}

/** The Poppy issuer the authorization server announces (`Symbol.for('@adonis-agora/poppy:issuer')`), if any. */
export function globalPoppyIssuer(): string | undefined {
  const value = (globalThis as Record<symbol, unknown>)[POPPY_ISSUER_SLOT];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The Poppy issuer announced in this process, if any — alias of {@link globalPoppyIssuer}. */
export const announcedPoppyIssuer = globalPoppyIssuer;

/**
 * Announce this app's Poppy endpoints to an authorization server in the same process — it reads
 * this slot when it builds `poppy.json`, so the conversation endpoint never has to be repeated in
 * its config (`agent.protocols: [{ type: 'poppy', endpoint }]`). The contract is the global symbol
 * (its name shared with `@adonis-agora/authkit-server`): neither package imports the other.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec),
 * a spec still in development: this API WILL change as the spec evolves — possibly in breaking
 * ways, outside semver majors while it is a draft.
 */
export const POPPY_ENDPOINTS_SLOT = Symbol.for('@adonis-agora/poppy:endpoints');

/** What the slot holds: absolute URLs, by kind. */
export interface PoppyEndpoints {
  /** The conversation endpoint (§7) — the `endpoint` of the `poppy` protocol entry. */
  conversations?: string;
  [kind: string]: string | undefined;
}

/** The absolute conversation endpoint for a public base URL and a mount path. */
export function poppyConversationsUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+|\/+$/g, '')}`;
}

/** Merge `endpoints` into the slot, keeping what another package announced. */
export function announcePoppyEndpoints(endpoints: PoppyEndpoints): void {
  const slot = globalThis as Record<symbol, unknown>;
  const existing = slot[POPPY_ENDPOINTS_SLOT];
  slot[POPPY_ENDPOINTS_SLOT] = {
    ...(existing && typeof existing === 'object' ? (existing as PoppyEndpoints) : {}),
    ...endpoints,
  };
}

/** What the slot holds now (a copy), or `{}`. */
export function announcedPoppyEndpoints(): PoppyEndpoints {
  const existing = (globalThis as Record<symbol, unknown>)[POPPY_ENDPOINTS_SLOT];
  return existing && typeof existing === 'object' ? { ...(existing as PoppyEndpoints) } : {};
}
