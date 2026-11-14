import type { ExecutionContext, Logger } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import type { DevToolsCaller } from './contract.js';
import {
  type ConsoleAuthorize,
  type ConsoleDecide,
  type ConsoleDecision,
  resolveDevToolsAuthorize,
} from './endpoint-authorize.js';

/** The action tool a {@link DevToolsActionsAuthorizer} is asked about. */
export interface DevToolsActionRequest {
  /** The lib id: `'payments'`. */
  lib: string;
  /** The full tool name: `'payments_refund_payment'`. */
  tool: string;
  /** Whether the lib marked it as cancelling, refunding, revoking or deleting something. */
  destructive: boolean;
  /** Who is calling (`'user:42'`, `'token:…'`, `'dev-open'`). */
  caller: DevToolsCaller;
}

/**
 * The function form of `devTools.actions`: decides each action tool for this request. It receives
 * the request (`context.switchToHttp().getRequest()`: Express's, or Fastify's wrapper) and runs while
 * the request's tools are assembled, so a refusal both hides the tool from `tools/list` and refuses a
 * call to it. Anything but `true`, or a throw, refuses.
 */
export type DevToolsActionsAuthorizer<TRequest = any> = (
  request: TRequest,
  action: DevToolsActionRequest,
) => boolean | Promise<boolean>;

/**
 * The map form of `devTools.actions`: lib ids and full tool names, each to a console `authorize`
 * (a function, a class with `authorize()`, a lazy import, `{ policy, ability }` or a gate name). A
 * tool-name key wins over its lib's key; an action in neither is refused.
 */
export type DevToolsActionsMap = Record<string, ConsoleAuthorize>;

/**
 * What `devTools.actions` may say:
 * - `'refuse'` (default): no action tool is listed or callable.
 * - `'execute'`: every action tool of an allowed lib.
 * - `string[]`: those of these lib ids or tool names.
 * - {@link DevToolsActionsMap}: per lib or per tool, each with its own `authorize`.
 * - {@link DevToolsActionsAuthorizer}: a function deciding each action tool.
 */
export type DevToolsActions =
  | 'refuse'
  | 'execute'
  | string[]
  | DevToolsActionsMap
  | DevToolsActionsAuthorizer;

/** Why an action tool was left out, for the debug line. */
export interface DevToolsActionRefusal {
  reason: 'not-configured' | 'denied' | 'threw';
  error?: unknown;
}

/** The map form's `authorize`s, each resolved once at boot. */
export type ResolvedActionsMap = ReadonlyMap<ConsoleAuthorize, ConsoleDecide>;

/** Whether `actions` is the map form. */
export function isActionsMap(actions: unknown): actions is DevToolsActionsMap {
  return actions !== null && typeof actions === 'object' && !Array.isArray(actions);
}

/** Whether `actions` decides per caller (map or function), rather than statically. */
export function isDynamicActions(actions: DevToolsActions): boolean {
  return typeof actions === 'function' || isActionsMap(actions);
}

/**
 * Resolves each distinct `authorize` of the map form (a configuration mistake, such as a gate name
 * without nestjs-authz, throws: call it at boot). Empty for any other form.
 */
export async function resolveActionsMap(
  actions: DevToolsActions,
  moduleRef: ModuleRef | undefined,
  logger: Logger,
): Promise<ResolvedActionsMap> {
  const resolved = new Map<ConsoleAuthorize, ConsoleDecide>();
  if (!isActionsMap(actions)) return resolved;
  const keys = Object.keys(actions);
  if (keys.length > 0 && moduleRef === undefined) {
    throw new Error('AgentMcpServerModule: `devTools.actions` needs ModuleRef to resolve.');
  }
  // A refused action logs at debug, a throwing `authorize` included.
  const quiet = { warn: (message: string) => logger.debug(message) } as unknown as Logger;
  for (const key of keys) {
    const authorize = actions[key] as ConsoleAuthorize;
    if (resolved.has(authorize)) continue;
    try {
      resolved.set(
        authorize,
        await resolveDevToolsAuthorize(authorize, moduleRef as ModuleRef, { logger: quiet }),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`AgentMcpServerModule: \`devTools.actions['${key}']\`: ${reason}`, {
        cause: error,
      });
    }
  }
  return resolved;
}

/**
 * One request's view of `devTools.actions`: each distinct `authorize` of the map runs at most once,
 * however many tools point at it.
 */
export class DevToolsActionsGate {
  readonly #decisions = new Map<ConsoleAuthorize, Promise<true | DevToolsActionRefusal>>();

  constructor(
    private readonly actions: DevToolsActions,
    private readonly resolved: ResolvedActionsMap,
    private readonly context: ExecutionContext,
    private readonly caller: DevToolsCaller,
  ) {}

  /** Whether `actions` decides per caller (map or function), rather than statically. */
  get dynamic(): boolean {
    return isDynamicActions(this.actions);
  }

  /** `true` when the action tool is served to this request, else why not. */
  async decide(action: {
    lib: string;
    tool: string;
    destructive: boolean;
  }): Promise<true | DevToolsActionRefusal> {
    const actions = this.actions;
    if (actions === 'execute') return true;
    // `null` / `undefined` from an untyped config: the default, refuse.
    if (actions === 'refuse' || actions === null || actions === undefined) {
      return { reason: 'not-configured' };
    }
    if (Array.isArray(actions)) {
      return actions.includes(action.lib) || actions.includes(action.tool)
        ? true
        : { reason: 'not-configured' };
    }
    if (typeof actions === 'function') {
      try {
        const request = this.context.switchToHttp().getRequest();
        const allowed = await actions(request, { ...action, caller: this.caller });
        return allowed === true ? true : { reason: 'denied' };
      } catch (error) {
        return { reason: 'threw', error };
      }
    }
    const authorize = own(actions, action.tool) ?? own(actions, action.lib);
    if (authorize === undefined) return { reason: 'not-configured' };
    let decision = this.#decisions.get(authorize);
    if (decision === undefined) {
      decision = this.#run(authorize);
      this.#decisions.set(authorize, decision);
    }
    return decision;
  }

  async #run(authorize: ConsoleAuthorize): Promise<true | DevToolsActionRefusal> {
    const decide = this.resolved.get(authorize);
    // Not resolved at boot (the map changed after it): refuse rather than guess.
    if (decide === undefined) return { reason: 'not-configured' };
    const decision: ConsoleDecision = await decide(this.context);
    // `{ redirectTo }` and `unauthenticated` are refusals too: there is no page to send an MCP
    // client to. A throw was already turned into `forbidden` (and logged) by the resolver.
    return decision.allowed ? true : { reason: 'denied' };
  }
}

function own(map: DevToolsActionsMap, key: string): ConsoleAuthorize | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}
