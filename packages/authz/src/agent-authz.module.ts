import { AGENT_ROLES_POLICY } from '@dudousxd/nestjs-agent-core';
import { Gate } from '@dudousxd/nestjs-authz';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { AuthzRolesPolicy, type AuthzRolesPolicyOptions } from './authz-roles-policy.js';

/**
 * Wires an authz-backed {@link AuthzRolesPolicy} as nestjs-agent's `RolesPolicy`,
 * binding it under the shared {@link AGENT_ROLES_POLICY} token so the agent loop's
 * tool gate consults the {@link Gate}.
 *
 * The {@link Gate} is injected from the app's global `AuthzModule` — this module does
 * NOT import `AuthzModule`; the app is expected to register it once at the root.
 */
@Global()
@Module({})
export class AgentAuthzModule {
  static forRoot(options?: AuthzRolesPolicyOptions): DynamicModule {
    return {
      module: AgentAuthzModule,
      providers: [
        {
          provide: AGENT_ROLES_POLICY,
          useFactory: (gate: Gate) => new AuthzRolesPolicy(gate, options),
          inject: [Gate],
        },
      ],
      exports: [AGENT_ROLES_POLICY],
    };
  }
}
