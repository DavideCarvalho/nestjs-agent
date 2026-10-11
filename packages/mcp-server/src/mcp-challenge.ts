import type { ServerResponse } from 'node:http';
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';

/**
 * Error codes this server puts in a `WWW-Authenticate: Bearer` challenge: RFC 6750's `invalid_token`
 * and `insufficient_scope`, Poppy's `sign_in_required` (§4.3), and whatever else a token verifier
 * answers (`invalid_dpop_proof`, `use_dpop_nonce`).
 */
export type McpChallengeError =
  | 'invalid_token'
  | 'insufficient_scope'
  | 'sign_in_required'
  | (string & {});

/** What one refusal tells the client beyond its status. */
export interface McpChallenge {
  /** The challenge's `error`. Omitted when the request carried no token at all (RFC 6750 §3.1). */
  error?: McpChallengeError;
  /** With `insufficient_scope`: the scopes the request needs, space-separated (RFC 6750 §3). */
  scope?: string;
  /** Human-readable reason — the body's `message`, never the token. */
  description?: string;
  /** A finished challenge to answer with verbatim (a token verifier's own), instead of building one. */
  wwwAuthenticate?: string;
  /** The protected-resource metadata URL (RFC 9728 §5.1), when this server serves one. */
  resourceMetadataUrl?: string;
  /** Extra headers to answer with — a verifier's `DPoP-Nonce`. */
  headers?: Readonly<Record<string, string>>;
}

/**
 * An MCP refusal that must reach the client with its `WWW-Authenticate` challenge: the header is
 * what an OAuth-aware client acts on (log in, ask the user for a scope, sign in again), and Nest's
 * default error path drops every header an exception would like to send.
 *
 * Throw it from an `auth` resolver to choose the challenge yourself (e.g. `403` +
 * `sign_in_required`); the MCP controller answers it through {@link McpChallengeFilter}.
 */
export class McpChallengeException extends HttpException {
  constructor(
    status: number,
    readonly challenge: McpChallenge = {},
  ) {
    super(
      {
        statusCode: status,
        error: challenge.error ?? (status === 401 ? 'Unauthorized' : 'Forbidden'),
        message: challenge.description ?? challenge.error ?? 'unauthorized',
      },
      status,
    );
    this.name = 'McpChallengeException';
  }

  /** The same refusal, naming the metadata URL — unless it names one already. */
  withResourceMetadata(url: string | undefined): McpChallengeException {
    if (url === undefined || this.challenge.resourceMetadataUrl !== undefined) return this;
    return new McpChallengeException(this.getStatus(), {
      ...this.challenge,
      resourceMetadataUrl: url,
    });
  }

  /** The `WWW-Authenticate` value this refusal answers with. */
  wwwAuthenticate(): string {
    const { challenge } = this;
    const metadata =
      challenge.resourceMetadataUrl !== undefined
        ? `resource_metadata="${quote(challenge.resourceMetadataUrl)}"`
        : undefined;
    if (challenge.wwwAuthenticate !== undefined) {
      // A verifier's own challenge is kept as it is; only the metadata pointer is added to it.
      return metadata === undefined || challenge.wwwAuthenticate.includes('resource_metadata=')
        ? challenge.wwwAuthenticate
        : `${challenge.wwwAuthenticate}, ${metadata}`;
    }
    const params: string[] = [];
    if (challenge.error !== undefined) params.push(`error="${quote(challenge.error)}"`);
    if (challenge.scope !== undefined) params.push(`scope="${quote(challenge.scope)}"`);
    if (metadata !== undefined) params.push(metadata);
    return params.length === 0 ? 'Bearer' : `Bearer ${params.join(', ')}`;
  }
}

/** Escape a challenge parameter value for a quoted-string (RFC 9110 §5.6.4). */
function quote(value: string): string {
  return value.replace(/[\\"]/g, (char) => `\\${char}`);
}

/**
 * Answers a {@link McpChallengeException} with its status, its challenge and extra headers. The MCP
 * endpoint already writes to the node response directly (the SDK transport needs one), so this does
 * too rather than going through a platform adapter.
 */
@Catch(McpChallengeException)
export class McpChallengeFilter implements ExceptionFilter<McpChallengeException> {
  catch(exception: McpChallengeException, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<ServerResponse>();
    if (res.headersSent) {
      res.end();
      return;
    }
    for (const [name, value] of Object.entries(exception.challenge.headers ?? {})) {
      res.setHeader(name, value);
    }
    res.setHeader('www-authenticate', exception.wwwAuthenticate());
    // A refusal is about this token at this moment; a cache replaying it would be wrong later.
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.statusCode = exception.getStatus();
    res.end(JSON.stringify(exception.getResponse()));
  }
}
