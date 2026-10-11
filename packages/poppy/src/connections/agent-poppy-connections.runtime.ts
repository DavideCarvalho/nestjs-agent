import { ActionProposalWorkerService, AgentService } from '@dudousxd/nestjs-agent';
import {
  AGENT_CHANNEL_FOLLOWER,
  AGENT_POPPY_CONNECTION_STORE,
  AGENT_STORE,
  AGENT_TOOL_REGISTRY,
  type ChannelFollower,
  InMemoryPoppyConnectionStore,
  type PoppyConnectionStore,
  type PoppyPendingConnect,
  type ToolRegistry,
} from '@dudousxd/nestjs-agent-core';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { AgentPoppyConnectionsModuleOptions } from './config.js';
import { type PoppyConnectionsExchange, createPoppyConnectionsHandler } from './http.js';
import {
  type PoppyFollow,
  type PoppyResumeStore,
  continueAfterConnect,
  resumeAfterConnect,
} from './resume.js';
import { PoppyConnections } from './service.js';
import { AGENT_POPPY_CONNECTIONS_OPTIONS } from './tokens.js';
import { registerPoppyConnectionTools } from './tools.js';

const logger = new Logger('AgentPoppyConnections');

/** The secret seals every stored connection: short ones are refused rather than weakly derived. */
const MIN_SECRET_LENGTH = 32;

/**
 * `token`'s provider wherever it is bound in the app, or `undefined`. Looked up when needed rather
 * than injected: the agent, its store and the channels' follower live in other modules (not all of
 * them exporting it to this one), and the module works without any of them.
 */
function lookup<T>(moduleRef: ModuleRef, token: unknown): T | undefined {
  try {
    return moduleRef.get(token as string, { strict: false }) as T;
  } catch {
    return undefined;
  }
}

/** Deliver a run to the text channel its page context names, when a channels module is mounted. */
function followVia(moduleRef: ModuleRef): PoppyFollow {
  return async (address, run) =>
    (await lookup<ChannelFollower>(moduleRef, AGENT_CHANNEL_FOLLOWER)?.follow(address, run)) ??
    false;
}

/** Builds the {@link PoppyConnections} the module binds — options checked, store picked. */
export function createModulePoppyConnections(
  options: AgentPoppyConnectionsModuleOptions,
  bound: PoppyConnectionStore | undefined,
  moduleRef: ModuleRef,
): PoppyConnections {
  if (typeof options.secret !== 'string' || options.secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `[nestjs-agent-poppy] AgentPoppyConnectionsModule: \`secret\` is required, at least ${MIN_SECRET_LENGTH} characters — it seals every stored connection.`,
    );
  }
  const store =
    options.store ??
    bound ??
    lookup<PoppyConnectionStore>(moduleRef, AGENT_POPPY_CONNECTION_STORE) ??
    memoryStore();
  return new PoppyConnections({
    config: options,
    store,
    secret: options.secret,
    production: process.env.NODE_ENV === 'production',
    // Resolved when a sign-in completes, never at boot: `connections` is built before the agent.
    onConnected: async (pending: PoppyPendingConnect) => {
      const service = lookup<AgentService>(moduleRef, AgentService);
      // No AgentService (an app running its own loop): nothing parked to resume.
      if (service === undefined) return;
      const connections = lookup<PoppyConnections>(moduleRef, PoppyConnections);
      await resumeAfterConnect(
        { service, store: lookup<PoppyResumeStore>(moduleRef, AGENT_STORE) },
        pending,
        // A sign-in that finished after its card expired still continues the conversation.
        connections ? { connections, follow: followVia(moduleRef) } : undefined,
      );
    },
    log: (line) => logger.warn(line),
  });
}

function memoryStore(): PoppyConnectionStore {
  logger.warn(
    'No PoppyConnectionStore bound (`store`, or a store module binding AGENT_POPPY_CONNECTION_STORE): connections are kept in memory and lost on restart.',
  );
  return new InMemoryPoppyConnectionStore();
}

/**
 * Wires {@link PoppyConnections} into the app: the `poppy_*` tools into `AGENT_TOOL_REGISTRY`, the
 * routes' handler, and — under independent approvals — the turn that continues the conversation
 * once a connect's outcome is admitted.
 */
@Injectable()
export class AgentPoppyConnectionsRuntime implements OnModuleInit, OnModuleDestroy {
  readonly handle: (ex: PoppyConnectionsExchange) => Promise<boolean>;
  #unsubscribe: (() => void) | null = null;

  constructor(
    @Inject(AGENT_POPPY_CONNECTIONS_OPTIONS) readonly options: AgentPoppyConnectionsModuleOptions,
    @Inject(PoppyConnections) readonly connections: PoppyConnections,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
  ) {
    this.handle = createPoppyConnectionsHandler(connections, {
      ...(options.render !== undefined ? { render: options.render } : {}),
      onError: (error) => logger.error('poppy-connections: request failed', error),
    });
  }

  onModuleInit(): void {
    const tools = this.options.tools ?? {};
    // The agent's registry when there is one; an app with its own loop registers the tools in its
    // own registry (`tools.register: false` + `registerPoppyConnectionTools`).
    const registry = lookup<ToolRegistry>(this.moduleRef, AGENT_TOOL_REGISTRY);
    if (tools.register !== false && registry !== undefined) {
      registerPoppyConnectionTools(registry, this.connections, tools);
    }
    // Independent approvals: once the decided `connect` ran and its outcome is in the thread, go on
    // with the person's request (a new turn), on the channel it came from.
    const worker = lookup<ActionProposalWorkerService>(this.moduleRef, ActionProposalWorkerService);
    if (tools.connect === 'link' || worker === undefined) return;
    this.#unsubscribe = worker.onAdmitted(async (outcome) => {
      const service = lookup<AgentService>(this.moduleRef, AgentService);
      if (service === undefined || service.actionApprovalMode() !== 'independent') return;
      await continueAfterConnect(
        { service, store: lookup<PoppyResumeStore>(this.moduleRef, AGENT_STORE) },
        this.connections,
        outcome,
        {
          ...(tools.prefix !== undefined ? { prefix: tools.prefix } : {}),
          follow: followVia(this.moduleRef),
        },
      ).catch((error) => logger.error('poppy-connections: continuing after connect failed', error));
    });
  }

  onModuleDestroy(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }
}
