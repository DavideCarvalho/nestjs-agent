import type { DynamicModule } from '@nestjs/common';
import { AgentModule } from '../agent.module.js';
import type { AgentModuleOptions } from '../agent.options.js';
import { AgentDurableModule } from './agent-durable.module.js';

/**
 * One-import setup for the durable runner. Spread the result into a module's `imports`:
 *
 * ```ts
 * imports: [DurableModule.forRoot({ ... }), ...agentDurable({ model, store, defaultAgent })]
 * ```
 *
 * It wires `AgentModule.forRoot({ ...options, durable: true })` together with `AgentDurableModule`,
 * the equivalent of importing both by hand. A configured `DurableModule` is still required. The
 * durable runner has no configuration of its own, so `options` is exactly the agent options.
 */
export function agentDurable(options: AgentModuleOptions): DynamicModule[] {
  return [AgentModule.forRoot({ ...options, durable: true }), AgentDurableModule.forRoot()];
}
