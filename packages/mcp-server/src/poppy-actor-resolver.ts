import {
  type Actor,
  type ActorResolver,
  PERSONAL_AGENT_ROLE,
  scopeRole,
} from '@dudousxd/nestjs-agent-core';
import { HttpException, HttpStatus } from '@nestjs/common';
import { McpChallengeException } from './mcp-challenge.js';
import { requestUrl } from './protected-resource.js';

/**
 * Who a Poppy request comes from: a Personal Agent (`clientId`) acting for one of its Users
 * (`userId`, the pairwise User ID — not an account) in one Session. `signedIn`, with the app
 * account (`accountId`) and `scopes`, once the User signed in here (§4.4); a signed-out token has
 * neither. The shape `@adonis-agora/authkit-server` answers.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1.
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
  /** What the app's `toActor` answered on the authorization server, when it has one. */
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

/** What a resolver may be asked to require besides a valid token. This resolver asks for none. */
export interface PoppyAuthOptions {
  scopes?: string[];
  signedIn?: boolean;
  resource?: string | null;
}

/** A refused token, with the challenge to answer it with. */
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
  /** For logs and the body — never the token. */
  description?: string;
  /** Extra headers to answer with (`DPoP-Nonce`). */
  headers?: Record<string, string>;
};

export type PoppyAuthResult = { ok: true; principal: PoppyPrincipal } | PoppyAuthFailure;

/**
 * Verifies a request's Session Token. `@adonis-agora/authkit-server` installs one in
 * {@link POPPY_AUTHENTICATE_SLOT}; an app can pass its own.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec),
 * a spec still in development: this API WILL change as the spec evolves.
 */
export type PoppyAuthenticate = (
  request: PoppyAuthRequest,
  options?: PoppyAuthOptions,
) => Promise<PoppyAuthResult>;

/**
 * The contract with the authorization server is this global symbol, not a module: neither side
 * imports the other. The name is that contract, so it is kept exactly as the server writes it.
 */
export const POPPY_AUTHENTICATE_SLOT = Symbol.for('@adonis-agora/poppy:authenticate');

/** The resolver installed in the global slot, if any — read per request, so install order is free. */
export function globalPoppyAuthenticate(): PoppyAuthenticate | undefined {
  const value = (globalThis as Record<symbol, unknown>)[POPPY_AUTHENTICATE_SLOT];
  return typeof value === 'function' ? (value as PoppyAuthenticate) : undefined;
}

/**
 * `actor` as a personal agent granted `scopes`: its roles plus `personal_agent` and one `scope:<id>`
 * per scope, so `personalAgentGate` applies — it is offered the tools written for personal agents
 * and runs only those of its scopes. For an app that verifies its personal agents' tokens itself.
 *
 * @experimental Part of the Personal Agent Protocol (Poppy, Draft 0.1) support.
 */
export function asPersonalAgent(actor: Actor, scopes: readonly string[]): Actor {
  return {
    ...actor,
    roles: [...new Set([...(actor.roles ?? []), PERSONAL_AGENT_ROLE, ...scopes.map(scopeRole)])],
  };
}

/** Options for {@link poppyActorResolver}. */
export interface PoppyActorResolverOptions {
  /** Your own Session Token verifier. Default: the one in {@link POPPY_AUTHENTICATE_SLOT}. */
  authenticate?: PoppyAuthenticate;
  /**
   * The MCP endpoint's public URL, handed to the verifier (DPoP `htu`, the token's `resource`).
   * Default: the request's own URL — set it behind a proxy that rewrites the scheme or host.
   */
  resource?: string;
  /**
   * The actor a signed-in principal acts as, when the authorization server did not answer one.
   * Default: `{ id: accountId }`. Whatever it returns becomes a personal agent of the token's scopes.
   */
  toActor?: (principal: PoppyPrincipal) => Actor | undefined | Promise<Actor | undefined>;
}

/** Read the headers off an unknown transport request. */
function headersOf(req: unknown): Record<string, string | string[] | undefined> {
  if (typeof req !== 'object' || req === null || !('headers' in req)) return {};
  const { headers } = req as { headers: unknown };
  return typeof headers === 'object' && headers !== null
    ? (headers as Record<string, string | string[] | undefined>)
    : {};
}

/**
 * An {@link ActorResolver} for the MCP tokens of Personal Agent Protocol (Poppy) sessions.
 *
 * Verifies the request's Bearer/DPoP Session Token with `authenticate` (default: the resolver
 * `@adonis-agora/authkit-server` installs in {@link POPPY_AUTHENTICATE_SLOT}) and answers the
 * principal's actor as a personal agent of the granted scopes ({@link asPersonalAgent}). Refusals
 * carry their challenge ({@link McpChallengeException}):
 *
 * - no token → `401` `Bearer`; a refused token → the verifier's status and challenge
 *   (`invalid_token`, `invalid_dpop_proof`, `use_dpop_nonce` with its `DPoP-Nonce`);
 * - a SIGNED-OUT Session's token → `403` `error="sign_in_required"` (Poppy §4.3): the token is valid
 *   but this server needs an account, and `invalid_token` would only make the agent mint another;
 * - no verifier at all → `501`: a deployment misconfiguration, not the caller's fault.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1; it WILL change as the spec evolves.
 */
export function poppyActorResolver(options: PoppyActorResolverOptions = {}): ActorResolver {
  return {
    async resolve(req: unknown): Promise<Actor> {
      const authenticate = options.authenticate ?? globalPoppyAuthenticate();
      if (authenticate === undefined) {
        throw new HttpException(
          'poppyActorResolver: no Poppy authenticate resolver — pass `authenticate`, or install @adonis-agora/authkit-server with Poppy on.',
          HttpStatus.NOT_IMPLEMENTED,
        );
      }
      const headers = headersOf(req);
      if (headers.authorization === undefined) {
        throw new McpChallengeException(401, { description: 'missing Session Token' });
      }
      const method = (req as { method?: unknown }).method;
      const result = await authenticate({
        method: typeof method === 'string' ? method : 'POST',
        url: options.resource ?? requestUrl(req),
        headers,
      });
      if (!result.ok) {
        throw new McpChallengeException(result.status, {
          error: result.error,
          wwwAuthenticate: result.wwwAuthenticate,
          ...(result.scope !== undefined ? { scope: result.scope } : {}),
          ...(result.description !== undefined ? { description: result.description } : {}),
          ...(result.headers !== undefined ? { headers: result.headers } : {}),
        });
      }
      const { principal } = result;
      const actor = principal.signedIn
        ? (principal.actor ??
          (await options.toActor?.(principal)) ??
          (principal.accountId !== null ? { id: principal.accountId } : undefined))
        : undefined;
      if (actor === undefined) {
        throw new McpChallengeException(403, {
          error: 'sign_in_required',
          description: 'sign in to use this server',
        });
      }
      return asPersonalAgent(actor, principal.scopes);
    },
  };
}
