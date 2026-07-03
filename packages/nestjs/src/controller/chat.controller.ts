import { AGENT_ACTOR_RESOLVER, type ActorResolver, type PageContext } from '@dudousxd/nestjs-agent-core';
import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AgentService } from '../agent.service.js';

interface ChatBody {
  message: string;
  threadId?: string;
  /** Name of the agent to run (orchestrator or a sub-agent). Defaults to the module's default. */
  agent?: string;
  persona?: string;
  pageContext?: PageContext;
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
      ...(body.persona !== undefined ? { personaId: body.persona } : {}),
      ...(body.pageContext !== undefined ? { pageContext: body.pageContext } : {}),
    });
    await this.pipe(res, runId, threadId);
  }

  @Get('chat/:runId/stream')
  async stream(@Param('runId') runId: string, @Res() res: Response): Promise<void> {
    await this.pipe(res, runId);
  }

  @Post('chat/:runId/cancel')
  async cancel(@Param('runId') runId: string): Promise<{ aborted: boolean }> {
    await this.agent.cancel(runId);
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
    for await (const chunk of this.agent.subscribe(runId)) {
      res.write(`data: ${JSON.stringify({ delta: decoder.decode(chunk) })}\n\n`);
    }
    res.write('event: done\ndata: {}\n\n');
    res.end();
  }
}
