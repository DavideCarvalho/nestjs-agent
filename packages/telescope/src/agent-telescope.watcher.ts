import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { AGENT_DIAGNOSTIC_EVENTS } from '@dudousxd/nestjs-agent-core';
import { channelName, claimDiagnostics } from '@dudousxd/nestjs-diagnostics';
import type { Watcher, WatcherContext } from '@dudousxd/nestjs-telescope';

interface DiagnosticEnvelope {
  event: string;
  payload: Record<string, unknown>;
}

/**
 * Records `aviary:agent:*` diagnostics events as Telescope entries of type `agent`. It depends
 * only on the diagnostics channel — not on the agent runtime — so it stays fully decoupled.
 *
 * Iterates {@link AGENT_DIAGNOSTIC_EVENTS} (all point events on `ChannelRegistry['agent']`)
 * rather than a hand-written literal, so `run.failed`/`delegated`/`retrieved` are recorded and
 * tagged — filterable in the Telescope UI — like every other agent event.
 *
 * Coexists with `@dudousxd/nestjs-diagnostics-telescope`'s generic watcher: `register()` CLAIMS
 * every recorded key via `claimDiagnostics('agent', ...)` (diagnostics 0.7+), so the generic
 * bridge skips them at record time instead of duplicating each event as a `diagnostic` entry —
 * no `exclude` wiring needed anymore. `dispose()` releases the claim.
 *
 * Register it with the telescope module's watcher list.
 */
export class AgentTelescopeWatcher implements Watcher {
  readonly type = 'agent';
  private readonly disposers: Array<() => void> = [];

  register(ctx: WatcherContext): void {
    // Tell the generic diagnostics bridge these keys are recorded here as typed `agent` entries,
    // so it skips them (refcounted; released in dispose()).
    this.disposers.push(claimDiagnostics('agent', AGENT_DIAGNOSTIC_EVENTS));
    for (const event of AGENT_DIAGNOSTIC_EVENTS) {
      const channel = channelName('agent', event);
      const onMessage = (message: unknown) => {
        const envelope = message as DiagnosticEnvelope;
        ctx.record({
          type: 'agent',
          content: { event: envelope.event, ...envelope.payload },
          tags: [envelope.event],
        });
      };
      subscribe(channel, onMessage);
      this.disposers.push(() => unsubscribe(channel, onMessage));
    }
  }

  /** Detach all channel subscriptions and release the diagnostics claim (e.g. on module destroy). */
  dispose(): void {
    while (this.disposers.length) this.disposers.pop()?.();
  }
}
