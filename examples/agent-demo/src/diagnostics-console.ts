import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { channelName } from '@dudousxd/nestjs-diagnostics';
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

const AGENT_EVENTS = ['run.started', 'message', 'tool-call', 'quota.exceeded', 'run.finished'];

/** Subscribes to every `aviary:agent:*` channel and prints it — proving the diagnostics glue. */
@Injectable()
export class AgentDiagnosticsConsole implements OnModuleInit, OnModuleDestroy {
  private readonly bindings: { name: string; handler: (message: unknown) => void }[] = [];

  onModuleInit(): void {
    for (const event of AGENT_EVENTS) {
      const name = channelName('agent', event);
      const handler = (message: unknown) => {
        const envelope = message as { lib: string; event: string; payload: unknown };
        // eslint-disable-next-line no-console
        console.log(`   📡 aviary:${envelope.lib}:${envelope.event}`, JSON.stringify(envelope.payload));
      };
      subscribe(name, handler);
      this.bindings.push({ name, handler });
    }
  }

  onModuleDestroy(): void {
    for (const { name, handler } of this.bindings) {
      unsubscribe(name, handler);
    }
  }
}
