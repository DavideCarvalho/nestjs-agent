import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { channelName } from '@dudousxd/nestjs-diagnostics';
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

const AGENT_EVENTS = [
  'run.started',
  'message',
  'tool-call',
  'delegated',
  'quota.exceeded',
  'run.finished',
];

interface Envelope {
  lib: string;
  event: string;
  payload: unknown;
}

/**
 * A real consumer of the `aviary:agent:*` diagnostics channel — not just a printer. This is the
 * answer to "what is diagnostics for?": an app subscribes ONCE and gets observability for free —
 * here we tally every event (a metrics sink would push these to Prometheus/OTel) and reconstruct
 * the orchestration graph from `delegated` events (an app could alert on it, or render it live).
 * The agent library stays oblivious; the wiring is one decoupled subscription.
 */
@Injectable()
export class AgentDiagnosticsConsole implements OnModuleInit, OnModuleDestroy {
  private readonly bindings: { name: string; handler: (message: unknown) => void }[] = [];
  private readonly counts = new Map<string, number>();
  private readonly delegations: { from: string; to: string }[] = [];

  onModuleInit(): void {
    for (const event of AGENT_EVENTS) {
      const name = channelName('agent', event);
      const handler = (message: unknown) => this.onEvent(message as Envelope);
      subscribe(name, handler);
      this.bindings.push({ name, handler });
    }
  }

  private onEvent(envelope: Envelope): void {
    this.counts.set(envelope.event, (this.counts.get(envelope.event) ?? 0) + 1);
    if (envelope.event === 'delegated') {
      const payload = envelope.payload as { fromAgent?: string; toAgent: string };
      this.delegations.push({ from: payload.fromAgent ?? 'default', to: payload.toAgent });
      // eslint-disable-next-line no-console
      console.log(`   🔀 delegation: ${payload.fromAgent ?? 'default'} → ${payload.toAgent}`);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`   📡 aviary:${envelope.lib}:${envelope.event}`, JSON.stringify(envelope.payload));
  }

  /** What an app does with the channel: metrics + an orchestration graph, derived, not instrumented. */
  summary(): { counts: Record<string, number>; delegations: { from: string; to: string }[] } {
    return { counts: Object.fromEntries(this.counts), delegations: this.delegations };
  }

  onModuleDestroy(): void {
    for (const { name, handler } of this.bindings) {
      unsubscribe(name, handler);
    }
  }
}
