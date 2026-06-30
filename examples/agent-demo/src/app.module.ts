import { AgentModule } from '@dudousxd/nestjs-agent';
import { AgentDurableModule } from '@dudousxd/nestjs-agent/durable';
import { InMemoryAgentStore, InMemoryQuotaStore } from '@dudousxd/nestjs-agent-testing';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore } from '@dudousxd/nestjs-durable-core';
import { Module } from '@nestjs/common';
import { AgentDiagnosticsConsole } from './diagnostics-console.js';
import { demoModel } from './model.js';
import { GetWeatherTool } from './tools/get-weather.tool.js';
import { PurgeCacheTool } from './tools/purge-cache.tool.js';

@Module({
  imports: [
    // Durable engine, fully in-process (no Redis) via the default transport + in-memory state store.
    DurableModule.forRoot({ store: new InMemoryStateStore() }),
    // The agent — each turn runs as the durable `agent.run` workflow.
    AgentModule.forRoot({
      model: demoModel,
      store: new InMemoryAgentStore(),
      quota: new InMemoryQuotaStore(200_000),
      modelId: 'fake-demo-1',
      systemPrompt: 'You are a helpful ops assistant for the demo.',
      personas: [
        { id: 'default', label: 'Default', systemPrompt: 'You are a helpful ops assistant.' },
      ],
      durable: true,
    }),
    // Multi-agent: an orchestrator that delegates to a focused sub-agent. The orchestrator can only
    // reach `weather-analyst` (via the synthesized `ask_weather_analyst` tool); the sub-agent can
    // only use `getWeather`. Each delegation is a durable child run AND a `delegated` diagnostics event.
    AgentModule.forFeature([
      {
        name: 'ops-orchestrator',
        systemPrompt: 'You coordinate specialists. Delegate weather questions to weather-analyst.',
        delegatesTo: ['weather-analyst'],
      },
      {
        name: 'weather-analyst',
        systemPrompt: 'You answer weather questions using the getWeather tool.',
        tools: ['getWeather'],
      },
    ]),
    AgentDurableModule,
  ],
  providers: [GetWeatherTool, PurgeCacheTool, AgentDiagnosticsConsole],
})
export class AppModule {}
