import 'reflect-metadata';
import type { ToolPresentation, ToolSpec } from '@dudousxd/nestjs-agent-core';

const GOVERN_METADATA = Symbol.for('@dudousxd/nestjs-agent:govern');

/**
 * What the agent adds to an `@AgentFunction()`: everything `@AiTool` declares that `@nestjs/ai` has
 * no word for. Its name, description and input schema stay `@AgentFunction()`'s.
 */
export interface GovernOptions {
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

/**
 * Governs an `@AgentFunction()` the agent offers its model: approval (`kind: 'action'`), roles, an
 * authz ability, a feature switch. Stack it on the same method; without it the function is still
 * offered, as a `read` tool under the policy's default roles.
 *
 * ```ts
 * @AgentFunction({ name: 'refund', description: 'Refund an order', inputSchema: RefundInput })
 * @Govern({ kind: 'action', roles: ['SUPPORT'] })
 * refund(input: RefundInput, ctx: AgentFunctionContext) { … }
 * ```
 */
export function Govern(options: GovernOptions = {}): MethodDecorator {
  return (_target, key, descriptor) => {
    if (typeof descriptor.value !== 'function') {
      throw new TypeError(`@Govern() goes on a method, and ${String(key)} is not one.`);
    }
    Reflect.defineMetadata(GOVERN_METADATA, { ...options }, descriptor.value);
    return descriptor;
  };
}

/** The `@Govern()` options of `method`, if it has them. */
export function readGovernMetadata(method: unknown): GovernOptions | undefined {
  if (typeof method !== 'function') return undefined;
  return Reflect.getMetadata(GOVERN_METADATA, method) as GovernOptions | undefined;
}
