import type { IncomingMessage, ServerResponse } from 'node:http';
import { Body, Controller, Delete, Get, Inject, Post, Req, Res } from '@nestjs/common';
import type { OpenCodeMcpEndpoint } from './mcp.js';
import { OPENCODE_MCP_ENDPOINT } from './tokens.js';

function notAllowed(res: ServerResponse): void {
  res.statusCode = 405;
  res.setHeader('allow', 'POST');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: 'method not allowed' }));
}

/**
 * `POST <agent path>/opencode/mcp` — the endpoint the engine registers in every OpenCode session
 * (`mcp.add`) when `tools` is set. It authenticates its callers itself (the bearer token the engine
 * minted for the session), so the module's `guards` are not applied to it. Stateless: no
 * server-sent stream to resume, no session to close.
 */
@Controller('opencode/mcp')
export class OpenCodeMcpController {
  constructor(@Inject(OPENCODE_MCP_ENDPOINT) private readonly endpoint: OpenCodeMcpEndpoint) {}

  @Post()
  async post(
    @Req() req: IncomingMessage,
    @Res() res: ServerResponse,
    @Body() body: unknown,
  ): Promise<void> {
    await this.endpoint.handle(req, res, body);
  }

  @Get()
  get(@Res() res: ServerResponse): void {
    notAllowed(res);
  }

  @Delete()
  delete(@Res() res: ServerResponse): void {
    notAllowed(res);
  }
}
