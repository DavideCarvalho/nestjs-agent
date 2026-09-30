import { createHash, randomBytes } from 'node:crypto';
import type { Actor, ActorResolver } from '@dudousxd/nestjs-agent-core';

export interface AnonymousActorOptions {
  /** The cookie holding the browser's anonymous token. Default `agent_anon`. */
  cookieName?: string;
  /** How long a browser keeps its identity (and so its threads). Default 365 days. */
  maxAgeDays?: number;
  /**
   * `SameSite` of the cookie. Default `'lax'` — sent on same-site requests, not on cross-site
   * POSTs. A SPA on another SITE than the API needs `'none'` (which forces `Secure`) plus
   * `credentials: 'include'` on the client.
   */
  sameSite?: 'lax' | 'strict' | 'none';
  /**
   * `Secure` flag. Default `'auto'`: set when the request arrived over HTTPS (`req.secure`, or an
   * `x-forwarded-proto: https` from a proxy).
   */
  secure?: boolean | 'auto';
  /** Cookie path. Default `/`. */
  path?: string;
  /** Roles every anonymous actor carries. Default `['anonymous']`. */
  roles?: string[];
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Where a token minted during this request is remembered, so two resolves in one request agree. */
const MINTED = Symbol('nestjs-agent:anonymous-token');

interface RequestLike {
  headers?: Record<string, string | string[] | undefined>;
  secure?: boolean;
  res?: {
    headersSent?: boolean;
    getHeader?: (name: string) => unknown;
    setHeader?: (name: string, value: string | string[]) => unknown;
  };
  [MINTED]?: string;
}

function readCookie(req: RequestLike, name: string): string | undefined {
  const header = req.headers?.cookie;
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (raw === undefined) return undefined;
  for (const pair of raw.split(';')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    if (pair.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(pair.slice(index + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function isHttps(req: RequestLike): boolean {
  if (req.secure === true) return true;
  const forwarded = req.headers?.['x-forwarded-proto'];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return proto?.split(',')[0]?.trim() === 'https';
}

/**
 * The zero-config identity: every browser is its own anonymous actor, so a login-less chat still
 * keeps each visitor's threads, quota and attachments apart from everyone else's.
 *
 * On a browser's first request the resolver mints 32 random bytes and sets them as an `HttpOnly`
 * cookie (`SameSite=Lax`, `Secure` over HTTPS). The actor id is a SHA-256 digest of that token —
 * `anon:<digest>` — never the token itself, so an id that surfaces anywhere (a thread row, a log, an
 * approval's `decidedBy`) cannot be replayed as the cookie.
 *
 * Why a server-minted cookie and not an id the client makes up and sends in a header: an
 * `HttpOnly` cookie is out of reach of page scripts (an XSS cannot lift it), the server — not the
 * client — decides the value, and it needs no client code at all. There is no signing secret to
 * configure: the token is unguessable on its own, and the digest works the same on every pod and
 * after a restart.
 *
 * Anonymous identities are per browser, not per person: clearing cookies starts over, and there is
 * nothing to recover them with. Require login with an `ActorResolver` that reads your session —
 * `requestUserActorResolver()` for `req.user` (Passport / cookie-session apps).
 */
export class AnonymousActorResolver implements ActorResolver {
  private readonly cookieName: string;
  private readonly roles: string[];

  constructor(private readonly options: AnonymousActorOptions = {}) {
    this.cookieName = options.cookieName ?? 'agent_anon';
    this.roles = options.roles ?? ['anonymous'];
  }

  resolve(request: unknown): Actor {
    const req = (typeof request === 'object' && request !== null ? request : {}) as RequestLike;
    let token = req[MINTED] ?? readCookie(req, this.cookieName);
    if (token === undefined || !TOKEN_PATTERN.test(token)) {
      token = randomBytes(32).toString('base64url');
      req[MINTED] = token;
      this.setCookie(req, token);
    }
    const digest = createHash('sha256').update(token).digest('base64url').slice(0, 32);
    return { id: `anon:${digest}`, roles: [...this.roles] };
  }

  private setCookie(req: RequestLike, token: string): void {
    const res = req.res;
    if (res?.setHeader === undefined || res.headersSent === true) return;
    const sameSite = this.options.sameSite ?? 'lax';
    const secureOption = this.options.secure ?? 'auto';
    const secure = sameSite === 'none' || (secureOption === 'auto' ? isHttps(req) : secureOption);
    const maxAge = Math.round((this.options.maxAgeDays ?? 365) * 24 * 60 * 60);
    const cookie = [
      `${this.cookieName}=${token}`,
      `Path=${this.options.path ?? '/'}`,
      `Max-Age=${maxAge}`,
      'HttpOnly',
      `SameSite=${sameSite === 'none' ? 'None' : sameSite === 'strict' ? 'Strict' : 'Lax'}`,
      ...(secure ? ['Secure'] : []),
    ].join('; ');
    const existing = res.getHeader?.('Set-Cookie');
    const list = Array.isArray(existing)
      ? existing.map(String)
      : existing !== undefined
        ? [String(existing)]
        : [];
    res.setHeader('Set-Cookie', [...list, cookie]);
  }
}
