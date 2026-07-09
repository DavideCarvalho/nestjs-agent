import {
  AGENT_GOVERNANCE_QUERIES,
  Agent,
  AgentModule,
  HeaderActorResolver,
  type PromptContext,
  SystemPrompt,
} from '@dudousxd/nestjs-agent';
import { AgentDashboardModule } from '@dudousxd/nestjs-agent-dashboard';
import {
  InMemoryAgentStore,
  InMemoryGovernanceQueries,
  InMemoryQuotaStore,
} from '@dudousxd/nestjs-agent-testing';
import { AgentDurableModule } from '@dudousxd/nestjs-agent/durable';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore } from '@dudousxd/nestjs-durable-core';
import { Global, Injectable, Module } from '@nestjs/common';
import { AgentDiagnosticsConsole } from './diagnostics-console.js';
import { demoModel } from './model.js';
import { GetWeatherTool } from './tools/get-weather.tool.js';
import { PurgeCacheTool } from './tools/purge-cache.tool.js';

// One shared store so the governance read-model sees exactly what the agent persists. A tiny pricing
// map turns recorded tokens into non-zero $ spend in the /ai-gateway console.
const demoStore = new InMemoryAgentStore();
const demoGovernance = new InMemoryGovernanceQueries(
  demoStore,
  new Map([['fake-demo-1', { inputPricePer1m: 3, outputPricePer1m: 15 }]]),
);

/** Exposes the governance read-model globally so the dashboard (and telescope) can resolve it. */
@Global()
@Module({
  providers: [{ provide: AGENT_GOVERNANCE_QUERIES, useValue: demoGovernance }],
  exports: [AGENT_GOVERNANCE_QUERIES],
})
class DemoGovernanceModule {}

/**
 * The default agent — handles a turn when no `agent` is selected. Its prompt is dynamic (built from
 * the turn's `PromptContext`) so it demonstrates a `@SystemPrompt()` method, not just a flat string.
 * No `tools` allow-list, so it may use every tool the actor's role allows (getWeather + purgeCache).
 */
@Agent({ name: 'default', model: 'fake-demo-1' })
@Injectable()
class DefaultAgent {
  @SystemPrompt()
  buildPrompt(ctx: PromptContext): string {
    return `You are a helpful ops assistant for ${ctx.actor.id}.${
      ctx.pageContext?.kind ? ` They are viewing the "${ctx.pageContext.kind}" page.` : ''
    }`;
  }
}

/** A focused specialist the orchestrator hands off to. Restricted to the `getWeather` tool. */
@Agent({
  name: 'weather-analyst',
  systemPrompt: 'You answer weather questions using the getWeather tool.',
  tools: ['getWeather'],
})
@Injectable()
class WeatherAnalystAgent {}

/**
 * Multi-agent: an orchestrator that delegates to `weather-analyst` (via the synthesized
 * `ask_weather_analyst` tool). Each delegation is a durable child run AND a `delegated` diagnostics
 * event.
 */
@Agent({
  name: 'ops-orchestrator',
  systemPrompt: 'You coordinate specialists. Delegate weather questions to weather-analyst.',
  handoff: [WeatherAnalystAgent],
})
@Injectable()
class OpsOrchestratorAgent {}

@Module({
  imports: [
    DemoGovernanceModule,
    // Durable engine, fully in-process (no Redis) via the default transport + in-memory state store.
    DurableModule.forRoot({ store: new InMemoryStateStore() }),
    // The standalone AI-gateway governance console at /ai-gateway (JSON API at /ai-gateway/api).
    AgentDashboardModule.forRoot(),
    // The agent — each turn runs as the durable `agent.run` workflow.
    AgentModule.forRoot({
      // --- infrastructure ---
      model: demoModel,
      store: demoStore,
      quota: new InMemoryQuotaStore(200_000),
      // Demo/gateway identity: trust x-actor-id / x-actor-role headers. Never fabricates a caller.
      actorResolver: new HeaderActorResolver(),
      durable: true,
      // Agents are declared as `@Agent` providers below; this just picks which one an unqualified
      // turn uses (there are three registered, so it can't fall back to "the single agent").
      defaultAgent: 'default',
    }),
    AgentDurableModule,
  ],
  providers: [
    GetWeatherTool,
    PurgeCacheTool,
    AgentDiagnosticsConsole,
    DefaultAgent,
    WeatherAnalystAgent,
    OpsOrchestratorAgent,
  ],
})
export class AppModule {}
