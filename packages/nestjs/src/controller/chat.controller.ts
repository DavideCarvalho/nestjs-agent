import {
  AGENT_ACTOR_RESOLVER,
  type ActorResolver,
  AgentStreamError,
  type PageContext,
} from '@dudousxd/nestjs-agent-core';
import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AgentService } from '../agent.service.js';

interface ChatBody {
  message: string;
  threadId?: string;
  /** Name of the agent to run (orchestrator or a sub-agent). Defaults to the module's default. */
  agent?: string;
  pageContext?: PageContext;
  /** Re-run the last exchange on `threadId` instead of adding a new message. */
  regenerate?: boolean;
}

@Controller()
export class ChatController {
  constructor(
    private readonly agent: AgentService,
    @Inject(AGENT_ACTOR_RESOLVER) private readonly actorResolver: ActorResolver,
  ) {}

  @Post('chat')
  async chat(@Req() req: Request, @Res() res: Response, @Body() body: ChatBody): Promise<void> {
    const actor = await this.actorResolver.resolve(req);
    const { runId, threadId } = await this.agent.chat({
      actor,
      message: body.message,
      ...(body.threadId !== undefined ? { threadId: body.threadId } : {}),
      ...(body.agent !== undefined ? { agentName: body.agent } : {}),
      ...(body.pageContext !== undefined ? { pageContext: body.pageContext } : {}),
      ...(body.regenerate === true ? { regenerate: true } : {}),
    });
    await this.pipe(res, runId, threadId);
  }

  @Get('chat/:runId/stream')
  async stream(@Param('runId') runId: string, @Res() res: Response): Promise<void> {
    await this.pipe(res, runId);
  }

  @Post('chat/:runId/cancel')
  async cancel(@Req() req: Request, @Param('runId') runId: string): Promise<{ aborted: boolean }> {
    const actor = await this.actorResolver.resolve(req);
    await this.agent.cancel(actor, runId);
    return { aborted: true };
  }

  private async pipe(res: Response, runId: string, threadId?: string): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Agent-Run-Id', runId);
    if (threadId !== undefined) {
      res.setHeader('X-Agent-Thread-Id', threadId);
    }
    res.write(`event: meta\ndata: ${JSON.stringify({ runId, threadId })}\n\n`);
    const decoder = new TextDecoder();
    try {
      for await (const chunk of this.agent.subscribe(runId)) {
        res.write(`data: ${JSON.stringify({ delta: decoder.decode(chunk) })}\n\n`);
      }
      res.write('event: done\ndata: {}\n\n');
    } catch (error) {
      // A run that failed terminates the sink with an AgentStreamError; surface it as a typed
      // error frame so the client can render a failure state instead of parsing it as a token.
      const payload =
        error instanceof AgentStreamError
          ? { code: error.code, message: error.message }
          : {
              code: 'run_failed',
              message: error instanceof Error ? error.message : 'stream error',
            };
      res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
    }
    res.end();
  }
}
