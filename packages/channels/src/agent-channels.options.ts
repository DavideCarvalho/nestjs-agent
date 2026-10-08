import type { ChannelStore } from '@dudousxd/nestjs-agent-core';
import type { DynamicModule, InjectionToken, OptionalFactoryDependency } from '@nestjs/common';
import type { ChannelWorkflowEngine } from './executor.js';
import type { ChannelOptions } from './handler.js';

export interface AgentChannelsModuleOptions {
  /** One entry per channel; each adapter's `name` must be unique — it is the route and the `via`. */
  channels: ChannelOptions[];
  /**
   * Where the channels' short-lived state lives: message ids already taken, questions waiting for an
   * answer, outcomes already relayed. Default: the `ChannelStore` bound to `AGENT_CHANNEL_STORE`
   * (`DrizzleAgentStoreModule` and `MikroOrmAgentStoreModule` bind one on `agent_channel_state`),
   * else this process's memory — fine for one replica only.
   */
  store?: ChannelStore;
  /**
   * Handle messages as `@dudousxd/nestjs-durable` runs: persisted before the `200`, one at a time per
   * conversation, retried, and resumed after a crash (a reply never lost, never sent twice).
   * Default: on when the agent runs durably (`AgentModule.forRoot({ durable: true })` with
   * `AgentDurableModule`), on the app's `WorkflowEngine`. `false` → in this process (a restart loses
   * what is in flight). An engine → that one.
   */
  durable?: boolean | ChannelWorkflowEngine;
}

interface AgentChannelsRouteOptions {
  /**
   * Where the webhook routes mount: `POST /<path>/<channel name>` (and `/<path>/<channel name>/:token`
   * for a provider that carries its secret in the url). Default `'channels'`. `false` mounts no
   * route — call `AgentChannelsService.handle(name, req, res)` from a controller of your own.
   * Static, like any route.
   */
  path?: string | false;
}

export type AgentChannelsModuleRootOptions = AgentChannelsModuleOptions & AgentChannelsRouteOptions;

/** Async variant, for channels built from config or services (`actor` looking accounts up). */
export interface AgentChannelsModuleAsyncOptions extends AgentChannelsRouteOptions {
  imports?: DynamicModule['imports'];
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useFactory: (
    ...deps: never[]
  ) => AgentChannelsModuleOptions | Promise<AgentChannelsModuleOptions>;
}
