import { All, Controller, Delete, Get, Inject, Param, Req, Res } from '@nestjs/common';
import { AgentPoppyConnectionsRuntime } from './agent-poppy-connections.runtime.js';
import type { PoppyConnectionsApiRequest } from './config.js';
import type { PoppyConnectionsExchange } from './http.js';
import { PoppyCompanyNotAllowedError } from './service.js';

/** The parts of an Express or Fastify request the routes read. */
interface HttpRequest extends AsyncIterable<unknown> {
  method: string;
  originalUrl?: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: Buffer | string;
  readableEnded?: boolean;
}

/** The parts of an Express response or a Fastify reply the routes answer through. */
interface HttpReply {
  status(code: number): unknown;
  header(name: string, value: string): unknown;
  send(body?: unknown): unknown;
}

/** The form a POST carried — parsed already by the app's body parser, or read off the stream. */
async function readBody(req: HttpRequest, limit: number): Promise<string> {
  if (req.rawBody !== undefined) return req.rawBody.toString();
  const body = req.body;
  if (typeof body === 'string') return body;
  if (body !== null && typeof body === 'object' && Object.keys(body).length > 0) {
    const form = new URLSearchParams();
    for (const [name, value] of Object.entries(body as Record<string, unknown>)) {
      for (const one of Array.isArray(value) ? value : [value]) form.append(name, String(one));
    }
    return form.toString();
  }
  if (req.readableEnded === true || typeof req[Symbol.asyncIterator] !== 'function') return '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function exchange(path: string, req: HttpRequest, res: HttpReply): PoppyConnectionsExchange {
  return {
    method: req.method.toUpperCase(),
    path,
    query: new URL(req.originalUrl ?? req.url, 'http://local/').searchParams,
    readBody: (limit) => readBody(req, limit),
    send(status, headers, body) {
      res.status(status);
      for (const [name, value] of Object.entries(headers)) res.header(name, value);
      res.send(body);
    },
  };
}

function json(res: HttpReply, status: number, body: unknown): void {
  res.status(status);
  res.header('content-type', 'application/json');
  res.header('cache-control', 'no-store');
  res.send(JSON.stringify(body));
}

/**
 * The routes under `AgentPoppyConnectionsModule`'s `path` (default `poppy-agent`): the agent
 * identity, the connect pages, the Direct Sign-In callback and — with `api` — the app's own
 * connections API. No session or CSRF: the connect id in the URL is the capability. Behind any
 * global guard the app has, so let these through it (they must be public: Companies fetch the
 * identity, and the person opens the link from a chat).
 */
@Controller()
export class AgentPoppyConnectionsController {
  constructor(
    @Inject(AgentPoppyConnectionsRuntime) private readonly runtime: AgentPoppyConnectionsRuntime,
  ) {}

  private async serve(rest: string, req: HttpRequest, res: HttpReply): Promise<void> {
    const handled = await this.runtime.handle(
      exchange(`/${this.runtime.connections.path}${rest}`, req, res),
    );
    if (!handled) json(res, 404, { error: 'not_found' });
  }

  @Get('agent.json')
  agent(@Req() req: HttpRequest, @Res() res: HttpReply) {
    return this.serve('/agent.json', req, res);
  }

  @Get('jwks.json')
  jwks(@Req() req: HttpRequest, @Res() res: HttpReply) {
    return this.serve('/jwks.json', req, res);
  }

  @Get('logo.svg')
  logo(@Req() req: HttpRequest, @Res() res: HttpReply) {
    return this.serve('/logo.svg', req, res);
  }

  @Get('oauth/callback')
  callback(@Req() req: HttpRequest, @Res() res: HttpReply) {
    return this.serve('/oauth/callback', req, res);
  }

  @All('connect/:id')
  connect(@Param('id') id: string, @Req() req: HttpRequest, @Res() res: HttpReply) {
    return this.serve(`/connect/${id}`, req, res);
  }

  @All('connect/:id/:action')
  connectAction(
    @Param('id') id: string,
    @Param('action') action: string,
    @Req() req: HttpRequest,
    @Res() res: HttpReply,
  ) {
    return this.serve(`/connect/${id}/${action}`, req, res);
  }

  @All('connect/:id/device/check')
  deviceCheck(@Param('id') id: string, @Req() req: HttpRequest, @Res() res: HttpReply) {
    return this.serve(`/connect/${id}/device/check`, req, res);
  }

  @Get('api/connections')
  async list(@Req() req: HttpRequest, @Res() res: HttpReply): Promise<void> {
    const owner = await this.owner(req, res);
    if (owner === null) return;
    json(res, 200, { connections: await this.runtime.connections.list(owner) });
  }

  @Delete('api/connections/:domain')
  async disconnect(
    @Param('domain') domain: string,
    @Req() req: HttpRequest,
    @Res() res: HttpReply,
  ): Promise<void> {
    const owner = await this.owner(req, res);
    if (owner === null) return;
    try {
      json(res, 200, { disconnected: await this.runtime.connections.disconnect(owner, domain) });
    } catch (error) {
      if (!(error instanceof PoppyCompanyNotAllowedError)) throw error;
      json(res, 400, { error: 'not_allowed', message: error.message });
    }
  }

  /** Whose connections the request is about; answered 404 (no `api`) or 401 (nobody) otherwise. */
  private async owner(req: HttpRequest, res: HttpReply): Promise<string | null> {
    const api = this.runtime.options.api;
    if (api === undefined) {
      json(res, 404, { error: 'not_found' });
      return null;
    }
    const actor = await api.actor(req as unknown as PoppyConnectionsApiRequest);
    if (actor === null) {
      json(res, 401, { error: 'unauthorized' });
      return null;
    }
    return this.runtime.connections.ownerOf(actor);
  }
}
