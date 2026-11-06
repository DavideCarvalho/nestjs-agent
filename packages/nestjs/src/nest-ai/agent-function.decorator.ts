import 'reflect-metadata';
import type { ToolPresentation, ToolSpec } from '@dudousxd/nestjs-agent-core';
import { type AgentFunctionOptions, AgentFunction as NestAgentFunction } from '@nestjs/ai';

const GOVERNANCE_METADATA = Symbol.for('@dudousxd/nestjs-agent:agent-function-governance');

/**
 * What the agent adds to `@nestjs/ai`'s `@AgentFunction()` options: everything `@AiTool` declares
 * that `@nestjs/ai` has no word for.
 */
export interface AgentFunctionGovernance {
  /**
   * `read` runs as the model asks; `action` waits for a person's approval (HITL), as an `action`
   * `@AiTool` does. Default `read` — the same default as `@AiTool`.
   */
  kind?: 'read' | 'action';
  /** Roles allowed to call it, gated by the `RolesPolicy`. Omit → the policy's `defaultRoles`. */
  roles?: string[];
  /** Authz ability checked by an ability-aware `RolesPolicy`. */
  ability?: string;
  /** Whether the tool exists in this deployment at all. Omit → it does. */
  enabled?: boolean | (() => boolean | Promise<boolean>);
  /** How the approval card and the tool-call row present it. */
  presentation?: ToolPresentation;
  /** The turn ends once this tool has run. */
  terminal?: boolean;
  /** Explicit identity for pending-only replacement of an `action` (see `@AiTool`). */
  replacementKey?: ToolSpec['replacementKey'];
}

/** `@nestjs/ai`'s `@AgentFunction()` options, and the agent's governance. */
export type GovernedAgentFunctionOptions = AgentFunctionOptions & AgentFunctionGovernance;

/**
 * `@nestjs/ai`'s `@AgentFunction()`, with the agent's governance: the method is an agent function
 * (`@nestjs/ai`'s calls offer it, through its guards, interceptors and pipes), and the agent offers
 * it too, governed — an `action` waits for a person's approval, `roles` gate who is offered it.
 *
 * ```ts
 * import { AgentFunction } from '@dudousxd/nestjs-agent';
 *
 * @AgentFunction({
 *   name: 'refund',
 *   description: 'Refund an order',
 *   inputSchema: RefundInput,
 *   kind: 'action',
 *   roles: ['SUPPORT'],
 * })
 * refund(input: RefundInput, ctx: AgentFunctionContext) { … }
 * ```
 *
 * A method with `@nestjs/ai`'s own `@AgentFunction()` is offered to the agent as well, as a `read`
 * tool under the policy's default roles; this one is that, plus the governance. A method takes one
 * of the two, not both.
 */
export function AgentFunction(options: GovernedAgentFunctionOptions = {}): MethodDecorator {
  const { kind, roles, ability, enabled, presentation, terminal, replacementKey, ...own } = options;
  const governance: AgentFunctionGovernance = {
    ...(kind !== undefined ? { kind } : {}),
    ...(roles !== undefined ? { roles } : {}),
    ...(ability !== undefined ? { ability } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(presentation !== undefined ? { presentation } : {}),
    ...(terminal !== undefined ? { terminal } : {}),
    ...(replacementKey !== undefined ? { replacementKey } : {}),
  };
  const nest = NestAgentFunction(own);
  return (target, key, descriptor) => {
    const result = nest(target, key, descriptor) ?? descriptor;
    Reflect.defineMetadata(GOVERNANCE_METADATA, governance, descriptor.value as object);
    return result;
  };
}

/** The agent's governance of an agent function's `method`, if it declared any. */
export function readAgentFunctionGovernance(method: unknown): AgentFunctionGovernance | undefined {
  if (typeof method !== 'function') return undefined;
  return Reflect.getMetadata(GOVERNANCE_METADATA, method) as AgentFunctionGovernance | undefined;
}
