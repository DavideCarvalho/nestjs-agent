import {
  AGENT_POPPY_CONNECTION_STORE,
  type PoppyConnectionStore,
} from '@dudousxd/nestjs-agent-core';
import {
  type DynamicModule,
  type InjectionToken,
  Module,
  type ModuleMetadata,
  type OptionalFactoryDependency,
  type Provider,
} from '@nestjs/common';
import { ModuleRef, RouterModule } from '@nestjs/core';
import { AgentPoppyConnectionsController } from './agent-poppy-connections.controller.js';
import {
  AgentPoppyConnectionsRuntime,
  createModulePoppyConnections,
} from './agent-poppy-connections.runtime.js';
import type { AgentPoppyConnectionsModuleOptions } from './config.js';
import { PoppyConnections } from './service.js';
import { AGENT_POPPY_CONNECTIONS_OPTIONS } from './tokens.js';

/** Where the identity, the connect pages and the callback live when `path` is omitted. */
const DEFAULT_PATH = 'poppy-agent';

/** `forRootAsync`: the options from a factory; `path` stays static (the routes mount at import). */
export interface AgentPoppyConnectionsModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  path?: string;
  useFactory: (
    ...args: never[]
  ) =>
    | Omit<AgentPoppyConnectionsModuleOptions, 'path'>
    | Promise<Omit<AgentPoppyConnectionsModuleOptions, 'path'>>;
  inject?: (InjectionToken | OptionalFactoryDependency)[];
}

/**
 * This app's agent acting on OTHER Poppy companies for its users: its agent identity
 * (`{path}/agent.json`, `jwks.json`, `logo.svg`), the connect pages and Direct Sign-In callback,
 * per-owner connections sealed at rest, the `poppy_*` tools in `AGENT_TOOL_REGISTRY`, and — with
 * `api` — `GET/DELETE {path}/api/connections[/:domain]` for the app's settings UI. Import it after
 * `AgentModule`.
 *
 * ```ts
 * imports: [
 *   AgentModule.forRoot({ … }),
 *   AgentPoppyConnectionsModule.forRoot({
 *     baseUrl: 'https://app.example',
 *     identity: { name: 'Acme Assistant', keys: process.env.POPPY_AGENT_KEYS! },
 *     secret: process.env.POPPY_CONNECTIONS_SECRET!,
 *     companies: { 'shop.example': { label: 'Shop' } },
 *   }),
 * ]
 * ```
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec):
 * this API WILL change as the spec evolves — possibly in breaking ways, outside semver majors.
 */
@Module({})
export class AgentPoppyConnectionsModule {
  static forRoot(options: AgentPoppyConnectionsModuleOptions): DynamicModule {
    const path = clean(options.path);
    return build(path, [
      { provide: AGENT_POPPY_CONNECTIONS_OPTIONS, useValue: { ...options, path } },
    ]);
  }

  static forRootAsync(options: AgentPoppyConnectionsModuleAsyncOptions): DynamicModule {
    const path = clean(options.path);
    return build(
      path,
      [
        {
          provide: AGENT_POPPY_CONNECTIONS_OPTIONS,
          useFactory: async (...args: never[]) => ({
            ...(await options.useFactory(...args)),
            path,
          }),
          inject: options.inject ?? [],
        },
      ],
      options.imports ?? [],
    );
  }
}

function clean(path: string | undefined): string {
  return (path ?? DEFAULT_PATH).replace(/^\/+|\/+$/g, '');
}

function build(
  path: string,
  providers: Provider[],
  imports: NonNullable<ModuleMetadata['imports']> = [],
): DynamicModule {
  return {
    module: AgentPoppyConnectionsModule,
    imports: [RouterModule.register([{ path, module: AgentPoppyConnectionsModule }]), ...imports],
    controllers: [AgentPoppyConnectionsController],
    providers: [
      ...providers,
      {
        provide: PoppyConnections,
        useFactory: (
          options: AgentPoppyConnectionsModuleOptions,
          bound: PoppyConnectionStore | undefined,
          moduleRef: ModuleRef,
        ) => createModulePoppyConnections(options, bound, moduleRef),
        inject: [
          AGENT_POPPY_CONNECTIONS_OPTIONS,
          { token: AGENT_POPPY_CONNECTION_STORE, optional: true },
          ModuleRef,
        ],
      },
      AgentPoppyConnectionsRuntime,
    ],
    exports: [PoppyConnections],
  };
}
