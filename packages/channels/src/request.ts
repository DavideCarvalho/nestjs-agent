import type { ChannelHttpResponse } from './handler.js';
import type { ChannelRequest } from './types.js';

/**
 * The parts of an Express or Fastify request a channel reads. `rawBody` is there when the app was
 * created with `NestFactory.create(AppModule, { rawBody: true })` — WhatsApp Cloud's signature is
 * computed over it.
 */
export interface ChannelHttpRequest {
  method: string;
  originalUrl?: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  params?: unknown;
  body?: unknown;
  rawBody?: Buffer | string;
}

/** The parts of an Express response or a Fastify reply the route answers through. */
export interface ChannelHttpReply {
  status(code: number): unknown;
  header(name: string, value: string): unknown;
  send(body: unknown): unknown;
}

/** A {@link ChannelRequest} read off an Express or Fastify request. */
export function channelRequestOf(req: ChannelHttpRequest): ChannelRequest {
  const params =
    req.params !== null && typeof req.params === 'object'
      ? (req.params as Record<string, unknown>)
      : {};
  return {
    method: req.method.toUpperCase(),
    url: req.originalUrl ?? req.url,
    header: (name) => {
      const value = req.headers[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    },
    params,
    body: req.body,
    rawBody: req.rawBody ?? null,
  };
}

/** Write a {@link ChannelHttpResponse} to an Express response or a Fastify reply. */
export function sendChannelResponse(res: ChannelHttpReply, response: ChannelHttpResponse): void {
  res.status(response.status);
  if (typeof response.body === 'string') {
    res.header('content-type', response.contentType ?? 'text/plain');
    res.send(response.body);
    return;
  }
  res.header('content-type', 'application/json');
  res.send(JSON.stringify(response.body));
}
