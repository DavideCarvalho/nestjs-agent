import { Body, Controller, Post } from '@nestjs/common';
import { AgentService } from '../agent.service.js';

interface ApproveBody {
  runId: string;
  toolCallId: string;
}
interface RejectBody extends ApproveBody {
  reason?: string;
}

@Controller('tool-call')
export class ToolCallController {
  constructor(private readonly agent: AgentService) {}

  @Post('approve')
  async approve(@Body() body: ApproveBody): Promise<{ ok: boolean }> {
    await this.agent.approve(body.runId, body.toolCallId);
    return { ok: true };
  }

  @Post('reject')
  async reject(@Body() body: RejectBody): Promise<{ ok: boolean }> {
    await this.agent.reject(body.runId, body.toolCallId, body.reason);
    return { ok: true };
  }
}
