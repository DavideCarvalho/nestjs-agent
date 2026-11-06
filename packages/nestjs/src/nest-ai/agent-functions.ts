import type { Actor, AiToolCtx, ToolRegistry } from '@dudousxd/nestjs-agent-core';
import type { AiCaller, AiToolEntry, AiTools } from '@nestjs/ai';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { AI_TOOL_METADATA } from '../decorator/ai-tool.decorator.js';
import { readAgentFunctionGovernance } from './agent-function.decorator.js';

/**
 * Where `@AgentFunction()` files its options on the method — `@nestjs/ai`'s `AGENT_FUNCTION_METADATA`,
 * which its package does not export. Read for the function's own input schema: `AiTools` only keeps
 * the `ai` schema it was turned into, and the agent validates and describes tools from a Standard
 * Schema. When it cannot be read, the `ai` schema is adapted instead.
 */
const AGENT_FUNCTION_METADATA = 'nestjs:ai:agent-function';

/** Who an `@AgentFunction()` call acts for, from the actor of the turn. */
export type AgentFunctionCaller = (actor: Actor, ctx: AiToolCtx) => AiCaller;

/**
 * The default {@link AgentFunctionCaller}: the actor is the `user` (what `@nestjs/ai`'s guards read
 * where there is no request, as in a durable run). No `scopes`: the agent gates tools by roles, so a
 * function that requires scopes is refused unless `agentFunctionCaller` maps the actor to them.
 */
export const defaultAgentFunctionCaller: AgentFunctionCaller = (actor) => ({ user: actor });

/**
 * Registers every `@AgentFunction()` of the application as an agent tool, under the agent's
 * governance (the options of this library's `@AgentFunction()`), and runs each through `AiTools.call` — so the method's guards,
 * interceptors, pipes and exception filters run around it as they do for `@nestjs/ai`'s own calls.
 * A name the registry already has (an `@AiTool` of the same name) is skipped. Returns how many were
 * registered.
 */
export function registerAgentFunctions(
  registry: ToolRegistry,
  aiTools: AiTools,
  caller: AgentFunctionCaller,
  warn: (message: string) => void,
): number {
  let count = 0;
  for (const entry of aiTools.tools.values()) {
    // An `@AiTool`'s `execute()`: the agent registered it as the `@AiTool` it is.
    if (Reflect.getMetadata(AI_TOOL_METADATA, entry.host) !== undefined) continue;
    if (registry.has(entry.name)) {
      warn(
        `@AgentFunction "${entry.name}" (${entry.where}) duplicates a registered tool — skipped`,
      );
      continue;
    }
    const method = methodOf(entry);
    const govern = readAgentFunctionGovernance(method) ?? {};
    registry.register(
      {
        name: entry.name,
        kind: govern.kind ?? 'read',
        description: entry.description ?? entry.name,
        inputSchema: inputSchemaOf(entry, method),
        ...(govern.roles !== undefined ? { roles: govern.roles } : {}),
        ...(govern.ability !== undefined ? { ability: govern.ability } : {}),
        ...(govern.enabled !== undefined ? { enabled: govern.enabled } : {}),
        ...(govern.presentation !== undefined ? { presentation: govern.presentation } : {}),
        ...(govern.terminal === true ? { terminal: true } : {}),
        ...(govern.replacementKey !== undefined ? { replacementKey: govern.replacementKey } : {}),
      },
      {
        execute: (input, ctx) =>
          aiTools.call(entry, input, caller(ctx.actor, ctx), {
            ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
            ...(ctx.abortSignal !== undefined ? { abortSignal: ctx.abortSignal } : {}),
            ...(ctx.idempotencyKey !== undefined ? { idempotencyKey: ctx.idempotencyKey } : {}),
          }),
      },
    );
    count += 1;
  }
  return count;
}

/** The decorated method behind an entry: `entry.where` is `Class.method`. */
function methodOf(entry: AiToolEntry): unknown {
  const key = entry.where.slice(entry.where.lastIndexOf('.') + 1);
  const prototype = (entry.host as { prototype?: Record<string, unknown> }).prototype;
  return prototype?.[key];
}

function inputSchemaOf(entry: AiToolEntry, method: unknown): StandardSchemaV1 {
  const options =
    typeof method === 'function'
      ? (Reflect.getMetadata(AGENT_FUNCTION_METADATA, method) as
          | { inputSchema?: StandardSchemaV1 }
          | undefined)
      : undefined;
  if (options !== undefined) {
    // No `inputSchema`: the function takes no arguments.
    return options.inputSchema ?? z.object({});
  }
  return fromAiSchema(entry.inputSchema);
}

/**
 * An `ai` schema (`jsonSchema` + `validate`) as a Standard Schema. Its JSON Schema rides along as the
 * Standard JSON Schema extension when it is already resolved; a lazy one leaves the model a permissive
 * object, and the call is still validated against the real schema.
 */
function fromAiSchema(schema: AiToolEntry['inputSchema']): StandardSchemaV1 {
  const described = schema.jsonSchema as unknown;
  const resolved =
    typeof described === 'object' &&
    described !== null &&
    typeof (described as { then?: unknown }).then !== 'function'
      ? (described as Record<string, unknown>)
      : { type: 'object', properties: {}, additionalProperties: true };
  const json = () => resolved;
  return {
    '~standard': {
      version: 1,
      vendor: 'ai',
      validate: async (value: unknown) => {
        const result = await schema.validate?.(value);
        if (result === undefined) return { value };
        return result.success
          ? { value: result.value }
          : { issues: [{ message: result.error.message }] };
      },
      jsonSchema: { input: json, output: json },
    },
  } as unknown as StandardSchemaV1;
}
