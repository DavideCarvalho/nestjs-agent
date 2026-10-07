import type { InjectionToken, Provider } from '@nestjs/common';

/**
 * Something other than this library's loop that runs a turn — what `engine` on
 * `AgentModule.forRoot` takes. An engine owns the turn end to end (the model calls, the tools, the
 * context it keeps), and contributes the `AgentRunner` that `AGENT_RUNNER` binds to; everything
 * around the turn stays the library's: the routes and the stream protocol, threads and the store,
 * the sink, approvals and answers routed through `AgentService`, the queue and the quota.
 *
 * `openCode()` (`@dudousxd/nestjs-agent-opencode`) is the one that ships. An engine replaces the
 * loop, so the options only the loop reads (`model`, processors, `outputSchema`, `maxSteps`,
 * `history`, `retrieval`) do nothing under one; `model` becomes optional.
 */
export interface AgentEngine {
  /** For logs and diagnostics. */
  name: string;
  /** The providers the engine needs, its runner among them. */
  providers: Provider[];
  /** The token of the engine's `AgentRunner`, which `AGENT_RUNNER` is bound to. */
  runner: InjectionToken;
  /** Providers the app may inject too (the module is global): e.g. what an MCP surface hooks into. */
  exports?: InjectionToken[];
}
