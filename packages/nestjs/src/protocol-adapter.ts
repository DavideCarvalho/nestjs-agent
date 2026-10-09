import type { Provider, Type } from '@nestjs/common';

/**
 * A wire protocol other than the native one, served over the same runs — what `adapters` on
 * `AgentModule.forRoot` takes. An adapter contributes controllers, mounted under the agent's
 * `path` and guarded by its `guards` exactly like the native routes; the runs, the store, the
 * approvals and the quota are the library's, unchanged.
 *
 * `agUiAdapter()` and `a2uiAdapter()` (`/a2ui`) are the ones that ship. Write your own the same
 * way: a controller that injects `AgentService` (and `AGENT_ACTOR_RESOLVER`) and translates — by
 * the `AGENT_SERVICE` token when it ships in an entry of its own.
 */
export interface AgentProtocolAdapter {
  /** For logs and diagnostics. */
  name: string;
  /** Mounted under the agent's path. Not mounted at all on `surface: 'engine'`. */
  controllers: Type<object>[];
  /** Extra providers the controllers inject. */
  providers?: Provider[];
}
