import type { AiToolCtx } from '@dudousxd/nestjs-agent';
import { AiTool } from '@dudousxd/nestjs-agent';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

/** A read tool — auto-executes (no approval). */
@AiTool({
  name: 'getWeather',
  kind: 'read',
  description: 'Get the current weather for a city',
  input: z.object({ city: z.string() }),
})
@Injectable()
export class GetWeatherTool {
  async execute(input: { city: string }, ctx: AiToolCtx) {
    // Deterministic fake so the demo runs offline.
    const tempC = 15 + (input.city.length % 12);
    return { city: input.city, tempC, summary: 'partly cloudy', actor: ctx.actor.id };
  }
}
