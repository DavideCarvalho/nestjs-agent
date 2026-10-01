import type { Provider, Type } from '@nestjs/common';

/**
 * A wire protocol other than the native one, served over the same runs — what `adapters` on
 * `AgentModule.forRoot` takes. An adapter contributes controllers, mounted under the agent's
 * `path` and guarded by its `guards` exactly like the native routes; the runs, the store, the
 * approvals and the quota are the library's, unchanged.
 *
 * `agUiAdapter()` is the one that ships. Write your own the same way: a controller that injects
 * `AgentService` (and `AGENT_ACTOR_RESOLVER`) and translates.
 */
export interface AgentProtocolAdapter {
  /** For logs and diagnostics. */
  name: string;
  /** Mounted under the agent's path. Not mounted at all on `surface: 'engine'`. */
  controllers: Type<object>[];
  /** Extra providers the controllers inject. */
  providers?: Provider[];
}
