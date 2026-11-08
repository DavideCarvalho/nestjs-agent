import {
  type Actor,
  DEFAULT_ROLES_OF,
  type RolesPolicy,
  type ToolSpec,
  defaultRolesOf,
  requiresAbility,
} from '@dudousxd/nestjs-agent-core';
import type { AuthorizationService } from '@nestjs/authorization';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

const logger = new Logger('AgentAuthorization');

/**
 * `@nestjs/authorization`'s `AuthorizationService`, wherever the application imports
 * `AuthorizationModule` — or nothing, when it is not installed or not imported. Resolved once every
 * provider exists.
 */
@Injectable()
export class NestAuthorizationBinding implements OnModuleInit {
  #service: AuthorizationService | undefined;

  constructor(private readonly moduleRef: ModuleRef) {}

  async onModuleInit(): Promise<void> {
    let token: unknown;
    try {
      // An optional peer: imported when it is installed, so the agent runs without it.
      token = (await import('@nestjs/authorization')).AuthorizationService;
    } catch {
      return;
    }
    try {
      this.#service = this.moduleRef.get(token as never, { strict: false }) ?? undefined;
    } catch {
      this.#service = undefined;
    }
  }

  get service(): AuthorizationService | undefined {
    return this.#service;
  }
}

/** The user `@nestjs/authorization`'s policies receive for the turn's actor. */
export type AuthorizationUserOf = (actor: Actor) => unknown;

/**
 * The agent's gate, with `@nestjs/authorization` in it: a tool that requires abilities
 * (`ToolSpec.can`) is offered to, and callable by, an actor every one of them allows
 * (`AuthorizationService.can(policy, ability, user)`) — and, when it names `roles` too, an actor
 * holding one of them. A tool that requires none is the inner policy's call alone. Without an
 * `AuthorizationService` to ask, a tool that requires one reaches nobody: fail closed.
 */
export function authorizationGate(
  inner: RolesPolicy,
  service: () => AuthorizationService | undefined,
  userOf: AuthorizationUserOf,
): RolesPolicy {
  let warned = false;
  const allows = async (actor: Actor, tool: ToolSpec): Promise<boolean> => {
    const authorization = service();
    if (authorization === undefined) {
      if (!warned) {
        warned = true;
        logger.warn(
          `Tool "${tool.name}" requires @Can() abilities, and no AuthorizationService was found: it reaches nobody. Import AuthorizationModule from '@nestjs/authorization'.`,
        );
      }
      return false;
    }
    const user = userOf(actor);
    for (const { policy, ability, args } of tool.can ?? []) {
      // Checked one by one, in order: the first refusal answers, as the guard's would.
      const allowed = await (authorization.can as (...params: unknown[]) => Promise<boolean>).call(
        authorization,
        policy,
        ability,
        user,
        ...(args ?? []),
      );
      if (!allowed) {
        return false;
      }
    }
    return true;
  };
  /** The tool as the inner policy sees it: its roles, without the abilities it cannot evaluate. */
  const rolesOnly = ({ can: _, ...tool }: ToolSpec): ToolSpec => tool;
  const decide =
    (pick: (policy: RolesPolicy) => RolesPolicy['can']) =>
    async (actor: Actor, tool: ToolSpec): Promise<boolean> => {
      if (!requiresAbility(tool)) return pick(inner).call(inner, actor, tool);
      if (tool.roles !== undefined && !(await pick(inner).call(inner, actor, rolesOnly(tool)))) {
        return false;
      }
      return allows(actor, tool);
    };
  const defaults = defaultRolesOf(inner);
  return {
    can: decide((policy) => policy.can),
    canOffer: decide((policy) => policy.canOffer ?? policy.can),
    ...(defaults !== undefined ? { [DEFAULT_ROLES_OF]: defaults } : {}),
  } as RolesPolicy;
}
