import type { AgentEngine } from '@dudousxd/nestjs-agent';
import { type OpenCodeEngineOptions, openCodeControllers, openCodeProviders } from '../engine.js';
import { OPENCODE_TURNS } from '../tokens.js';
import { OpenCodeTurns } from '../turns.js';
import { DurableOpenCodeAgentRunner } from './runner.js';
import { OpenCodeRunWorkflow } from './workflow.js';

/**
 * `openCode()` whose turns are durable workflows — `AgentModule.forRoot({ engine:
 * openCodeDurable({ host }) })` next to a configured `DurableModule`. A turn waiting on a person
 * survives restarts and is resumed by whichever process receives the decision.
 */
export function openCodeDurable(options: OpenCodeEngineOptions): AgentEngine {
  return {
    name: 'opencode-durable',
    providers: [...openCodeProviders(options), OpenCodeRunWorkflow, DurableOpenCodeAgentRunner],
    runner: DurableOpenCodeAgentRunner,
    exports: [OpenCodeTurns, OPENCODE_TURNS],
    controllers: openCodeControllers(options),
  };
}

export { DurableOpenCodeAgentRunner } from './runner.js';
export { OPENCODE_RUN_WORKFLOW, OpenCodeRunWorkflow, decisionToken } from './workflow.js';
