import type {
  AgentStore,
  ApprovalPolicy,
  ModelProvider,
  TokenStreamSink,
} from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Inject, Injectable, type Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  InMemoryWorkflowStore,
  ManualWorkflowClock,
  WorkflowClient,
  WorkflowStorage,
  WorkflowWorker,
  WorkflowsModule,
} from '@nestjs/workflows';
import { AgentModule } from '../agent.module.js';
import type { AgentDurableOptions } from '../agent.options.js';
import { AgentService } from '../agent.service.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';
import { AgentWorkflowsModule } from './agent-workflows.module.js';
import { WorkflowsAgentRunner } from './workflows-agent-runner.js';

const SHARED_STORE = Symbol('shared workflow store');

/** Registers one store instance in every app of a test: the "database" a restart keeps. */
@Injectable()
class SharedWorkflowStore {
  constructor(storage: WorkflowStorage, @Inject(SHARED_STORE) store: InMemoryWorkflowStore) {
    storage.registerSource(store, { replace: true });
  }
}

export interface WorkflowsAppOptions {
  model: ModelProvider;
  providers: Provider[];
  /** Shared across apps to simulate a restart. */
  agentStore?: InMemoryAgentStore;
  workflowStore?: InMemoryWorkflowStore;
  clock?: ManualWorkflowClock;
  durable?: true | AgentDurableOptions;
  approvalPolicy?: ApprovalPolicy;
  sink?: TokenStreamSink;
}

/** An app on `@nestjs/workflows`: in-memory store, manual clock, no background worker (`drain()` runs). */
export async function buildWorkflowsApp(options: WorkflowsAppOptions) {
  const agentStore = options.agentStore ?? new InMemoryAgentStore();
  const workflowStore = options.workflowStore ?? new InMemoryWorkflowStore();
  const clock = options.clock ?? new ManualWorkflowClock();
  const moduleRef = await Test.createTestingModule({
    imports: [
      WorkflowsModule.forRoot({ clock, worker: { enabled: false, shutdownTimeout: 50 } }),
      AgentModule.forRoot({
        model: options.model,
        store: agentStore as AgentStore,
        actorResolver: new HeaderActorResolver(),
        durable: options.durable ?? true,
        defaultAgent: 'default',
        ...(options.approvalPolicy !== undefined ? { approvalPolicy: options.approvalPolicy } : {}),
        ...(options.sink !== undefined ? { sink: options.sink } : {}),
      }),
      AgentWorkflowsModule,
    ],
    providers: [
      { provide: SHARED_STORE, useValue: workflowStore },
      SharedWorkflowStore,
      ...options.providers,
    ],
  }).compile();
  await moduleRef.init();
  const worker = moduleRef.get(WorkflowWorker);
  return {
    moduleRef,
    agentStore,
    workflowStore,
    clock,
    service: moduleRef.get(AgentService),
    runner: moduleRef.get(WorkflowsAgentRunner),
    client: moduleRef.get(WorkflowClient),
    worker,
    /** Run every due instance until none is left. */
    drain: () => worker.drain(),
    close: () => moduleRef.close(),
  };
}

export type WorkflowsApp = Awaited<ReturnType<typeof buildWorkflowsApp>>;

export async function collect(iterable: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of iterable) {
    out += decoder.decode(chunk);
  }
  return out;
}
