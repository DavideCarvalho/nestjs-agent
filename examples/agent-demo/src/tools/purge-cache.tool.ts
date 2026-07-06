import type { AiToolCtx } from '@dudousxd/nestjs-agent';
import { AiTool } from '@dudousxd/nestjs-agent';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

/** An action tool — never auto-executes. The agent run SUSPENDS until a human approves. */
@AiTool({
  name: 'purgeCache',
  kind: 'action',
  description: 'Purge an application cache key (destructive — requires approval)',
  input: z.object({ key: z.string() }),
})
@Injectable()
export class PurgeCacheTool {
  async execute(input: { key: string }, ctx: AiToolCtx) {
    return { purged: input.key, by: ctx.actor.id, at: 'just now' };
  }
}
