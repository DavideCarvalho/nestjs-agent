import { subscribe } from 'node:diagnostics_channel';
import { channelName } from '@dudousxd/nestjs-diagnostics';
import type { Watcher, WatcherContext } from '@dudousxd/nestjs-telescope';

const AGENT_EVENTS = ['run.started', 'message', 'tool-call', 'quota.exceeded', 'run.finished'];

interface DiagnosticEnvelope {
  event: string;
  payload: Record<string, unknown>;
}

/**
 * Records `aviary:agent:*` diagnostics events as Telescope entries of type `agent`. It depends
 * only on the diagnostics channel — not on the agent runtime — so it stays fully decoupled.
 */
export class AgentTelescopeWatcher implements Watcher {
  readonly type = 'agent';

  register(ctx: WatcherContext): void {
    for (const event of AGENT_EVENTS) {
      subscribe(channelName('agent', event), (message) => {
        const envelope = message as DiagnosticEnvelope;
        ctx.record({
          type: 'agent',
          content: { event: envelope.event, ...envelope.payload },
          tags: [envelope.event],
        });
      });
    }
  }
}
