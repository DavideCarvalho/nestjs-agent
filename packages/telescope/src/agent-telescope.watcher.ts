import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { AGENT_DIAGNOSTIC_EVENTS } from '@dudousxd/nestjs-agent-core';
import { channelName } from '@dudousxd/nestjs-diagnostics';
import type { Watcher, WatcherContext } from '@dudousxd/nestjs-telescope';

interface DiagnosticEnvelope {
  event: string;
  payload: Record<string, unknown>;
}

/**
 * Records `aviary:agent:*` diagnostics events as Telescope entries of type `agent`. It depends
 * only on the diagnostics channel — not on the agent runtime — so it stays fully decoupled.
 *
 * Iterates {@link AGENT_DIAGNOSTIC_EVENTS} (all 8 events on `ChannelRegistry['agent']`) rather
 * than a hand-written literal, so `run.failed`/`delegated`/`retrieved` are recorded and tagged —
 * filterable in the Telescope UI — like every other agent event.
 *
 * **Superseded by `@dudousxd/nestjs-diagnostics-telescope`'s generic watcher,** which
 * auto-captures every `aviary:agent:*` channel registered in the diagnostics registry — prefer
 * that when the generic bridge is already in use; pass `agentDiagnosticKey(event)` keys to its
 * `exclude` option to mute a noisy one. This watcher is kept for standalone use without the
 * diagnostics telescope bridge.
 *
 * Register it with the telescope module's watcher list.
 */
export class AgentTelescopeWatcher implements Watcher {
  readonly type = 'agent';
  private readonly disposers: Array<() => void> = [];

  register(ctx: WatcherContext): void {
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

  /** Detach all channel subscriptions (e.g. on module destroy). */
  dispose(): void {
    while (this.disposers.length) this.disposers.pop()?.();
  }
}
