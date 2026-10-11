import type { IncomingMessage } from 'node:http';
import { Controller, Get, Inject, NotFoundException, Req, type Type } from '@nestjs/common';
import type { AgentMcpServerModuleOptions } from './agent-mcp-server.options.js';
import { AGENT_MCP_SERVER_OPTIONS } from './tokens.js';

/**
 * Where `@adonis-agora/authkit-server` announces its Poppy issuer. A cross-process contract with the
 * authorization server — the name is the protocol, so it is kept exactly as the server writes it.
 */
export const POPPY_ISSUER_SLOT = Symbol.for('@adonis-agora/poppy:issuer');

/** The well-known prefix of an RFC 9728 protected-resource metadata document. */
export const PROTECTED_RESOURCE_WELL_KNOWN = '.well-known/oauth-protected-resource';

/** OAuth settings this MCP server advertises in its protected-resource metadata (RFC 9728). */
export interface McpOAuthOptions {
  /** The authorization server that issues the tokens your `auth` resolver accepts. */
  issuer: string;
  /** The scopes a client may ask for. */
  scopesSupported?: string[];
  /** A human-readable name for this resource (shown on consent screens). */
  resourceName?: string;
}

/** The RFC 9728 document this server serves. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported?: string[];
  resource_name?: string;
}

/**
 * The Poppy issuer announced in this process, if any — read on every request, so the authorization
 * server can install it after this module boots.
 */
export function announcedPoppyIssuer(): string | undefined {
  const value = (globalThis as Record<symbol, unknown>)[POPPY_ISSUER_SLOT];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Whether a metadata document is served: an `oauth` option, or an announced Poppy issuer. */
export function servesProtectedResourceMetadata(oauth: McpOAuthOptions | undefined): boolean {
  return oauth !== undefined || announcedPoppyIssuer() !== undefined;
}

/**
 * The document for the MCP endpoint at `resource`. `authorization_servers` is the configured issuer
 * plus the announced Poppy issuer, once — Poppy §6 requires a listed MCP server to name it, so a
 * Poppy Session Token's issuer is one this resource trusts. `undefined` when there is nothing to
 * name.
 */
export function protectedResourceMetadata(input: {
  oauth: McpOAuthOptions | undefined;
  resource: string;
}): ProtectedResourceMetadata | undefined {
  const { oauth, resource } = input;
  const poppyIssuer = announcedPoppyIssuer();
  const servers = [
    ...new Set([
      ...(oauth !== undefined ? [oauth.issuer] : []),
      ...(poppyIssuer !== undefined ? [poppyIssuer] : []),
    ]),
  ];
  if (servers.length === 0) return undefined;
  return {
    resource,
    authorization_servers: servers,
    bearer_methods_supported: ['header'],
    ...(oauth?.scopesSupported !== undefined ? { scopes_supported: oauth.scopesSupported } : {}),
    ...(oauth?.resourceName !== undefined ? { resource_name: oauth.resourceName } : {}),
  };
}

/** `path` without leading or trailing slashes. */
export function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

/**
 * The public origin of a request: `baseUrl` when configured, else what the request says. Express'
 * `req.protocol` honours `trust proxy`; a raw node request is `https` only on a TLS socket. Behind a
 * proxy you have not told Express to trust, set `baseUrl`.
 */
export function requestOrigin(req: unknown, baseUrl?: string): string {
  if (baseUrl !== undefined) return baseUrl.replace(/\/+$/, '');
  const message = req as Partial<IncomingMessage> & { protocol?: unknown };
  const protocol =
    typeof message.protocol === 'string'
      ? message.protocol
      : (message.socket as { encrypted?: boolean } | undefined)?.encrypted === true
        ? 'https'
        : 'http';
  const host = message.headers?.host ?? 'localhost';
  return `${protocol}://${host}`;
}

/** The full public URL of a request, without its query — what a DPoP proof's `htu` names. */
export function requestUrl(req: unknown, baseUrl?: string): string {
  const message = req as Partial<IncomingMessage> & { originalUrl?: unknown };
  const raw = typeof message.originalUrl === 'string' ? message.originalUrl : (message.url ?? '/');
  const path = raw.split('?')[0] ?? '/';
  return `${requestOrigin(req, baseUrl)}${path}`;
}

/** The MCP endpoint's resource URL and the URL of its metadata document (RFC 9728 §3.1). */
export function mcpResourceUrls(input: { origin: string; path: string }): {
  resource: string;
  metadata: string;
} {
  const path = trimSlashes(input.path);
  return {
    resource: `${input.origin}/${path}`,
    metadata: `${input.origin}/${PROTECTED_RESOURCE_WELL_KNOWN}/${path}`,
  };
}

/** Serves `GET /.well-known/oauth-protected-resource/<mcp path>`. */
class McpProtectedResourceControllerBase {
  constructor(
    @Inject(AGENT_MCP_SERVER_OPTIONS) private readonly options: AgentMcpServerModuleOptions,
  ) {}

  @Get()
  metadata(@Req() req: IncomingMessage): ProtectedResourceMetadata {
    const urls = mcpResourceUrls({
      origin: requestOrigin(req, this.options.baseUrl),
      path: this.mcpPath,
    });
    const document = protectedResourceMetadata({
      oauth: this.options.oauth,
      resource: urls.resource,
    });
    // Neither an `oauth` option nor an announced Poppy issuer: there is no authorization server to
    // send a client to, so there is no document.
    if (document === undefined) throw new NotFoundException();
    return document;
  }

  /** Overridden by the per-path subclass {@link mcpProtectedResourceController} builds. */
  protected get mcpPath(): string {
    return 'mcp';
  }
}

/**
 * The metadata controller for the MCP endpoint at `path`. The document lives at the app ROOT (RFC
 * 9728 inserts the well-known segment between host and path), so it is a controller of its own,
 * mounted by a module the MCP route prefix does not apply to — and built per path, since a route is
 * static metadata.
 */
export function mcpProtectedResourceController(path: string): Type<unknown> {
  const mcpPath = trimSlashes(path);
  class McpProtectedResourceController extends McpProtectedResourceControllerBase {
    protected override get mcpPath(): string {
      return mcpPath;
    }
  }
  Controller(`${PROTECTED_RESOURCE_WELL_KNOWN}/${mcpPath}`)(McpProtectedResourceController);
  return McpProtectedResourceController;
}
