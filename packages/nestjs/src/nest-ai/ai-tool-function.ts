import { AsyncLocalStorage } from 'node:async_hooks';
import { type Actor, type AiToolCtx, markCanAnyone } from '@dudousxd/nestjs-agent-core';
import { type AgentFunctionContext, AgentFunction as NestAgentFunction } from '@nestjs/ai';
import { ForbiddenException } from '@nestjs/common';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/** The `@AiTool` options this file reads; the decorator's own type would import it back. */
interface AiToolShape {
  name: string;
  kind: 'read' | 'action';
  description: string;
  input: StandardSchemaV1;
  roles?: string[];
  enabled?: boolean | (() => boolean | Promise<boolean>);
}

/** An agent turn's call of an `@AiTool`, carried past `@nestjs/ai`'s enhancers to the method. */
interface AgentCall {
  ctx: AiToolCtx;
  output?: { value: unknown };
  error?: { error: unknown };
}

const calls = new AsyncLocalStorage<AgentCall>();

/** What model providers accept as a tool name, which `@nestjs/ai` asserts at startup. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Whether `@nestjs/ai` can take the tool as an agent function: a name model providers accept, and an
 * input schema that produces JSON Schema (Zod 4, ArkType, Valibot with `toStandardJsonSchema`). A
 * tool that cannot stays the agent's alone — `@nestjs/ai` would refuse the whole boot over it.
 */
function canBeAgentFunction(options: AiToolShape): boolean {
  const standard = (options.input as { '~standard'?: { jsonSchema?: { input?: unknown } } })[
    '~standard'
  ];
  return TOOL_NAME.test(options.name) && typeof standard?.jsonSchema?.input === 'function';
}

/**
 * Makes an `@AiTool` class's `execute()` a `@nestjs/ai` agent function too: `@nestjs/ai`'s own calls
 * (`AiService.generateText({ tools: ['getWeather'] })`) can offer it, and the agent's calls run it
 * through the method's guards, interceptors and pipes.
 *
 * `execute()` keeps receiving the agent's `AiToolCtx`. In an agent turn it is the turn's, carried
 * past the enhancers; in a call of `@nestjs/ai`'s own there is no turn, so it is built from the call's
 * context (`user` → `actor`) — and the agent's governance that only a turn can apply is applied here
 * as a refusal: an `action` needs a person's approval, which only a turn asks for, and declared
 * `roles` must intersect the user's.
 *
 * Returns whether it did: a tool `@nestjs/ai` cannot take (see {@link canBeAgentFunction}) is left
 * as it is.
 */
/** A method, called with its `this`. */
type Method = (this: unknown, input: unknown, ctx: unknown) => unknown;

export function defineAiToolAgentFunction(
  target: { prototype: unknown },
  options: AiToolShape,
): boolean {
  const prototype = target.prototype as Record<string, unknown>;
  const original = prototype.execute;
  if (typeof original !== 'function' || !canBeAgentFunction(options)) return false;

  function execute(this: unknown, input: unknown, ctx: unknown): Promise<unknown> {
    const call = calls.getStore();
    if (call !== undefined) {
      return Promise.resolve()
        .then(() => (original as Method).call(this, input, call.ctx))
        .then(
          (value) => {
            call.output = { value };
            return value;
          },
          (error: unknown) => {
            call.error = { error };
            throw error;
          },
        );
    }
    // Anything but `@nestjs/ai`'s own call — the agent's context with no `AiModule`, a caller that
    // holds the instance (a unit test calling `execute(input)`, with a partial context or none) —
    // is the call it always was, handed to `execute()` untouched.
    if (!isAgentFunctionContext(ctx)) {
      return Promise.resolve((original as Method).call(this, input, ctx));
    }
    const context = ctx as AgentFunctionContext;
    if (options.kind === 'action') {
      throw new ForbiddenException(
        `"${options.name}" is an action: it runs only in an agent turn, once a person approves it.`,
      );
    }
    const actor = actorOf(context.user);
    // The tool's own `roles` only: the agent's `RolesPolicy` (its `defaultRoles`, an authz ability)
    // is the agent's, and a call of `@nestjs/ai`'s own runs outside it. An empty list is open, as
    // the agent's default policy reads it.
    const roles = options.roles ?? [];
    const allowed = roles.length === 0 || (actor.roles ?? []).some((role) => roles.includes(role));
    if (options.enabled === false || !allowed) {
      throw new ForbiddenException(`"${options.name}" is not allowed for this caller.`);
    }
    return Promise.resolve((original as Method).call(this, input, toolCtxOf(context, actor)));
  }

  // The enhancers `execute()` declares (`@UseGuards()` and the like) are metadata on the method:
  // they move to the method that replaces it.
  for (const key of Reflect.getMetadataKeys(original)) {
    Reflect.defineMetadata(key, Reflect.getMetadata(key, original), execute);
  }
  // Governed by the agent (its roles, an `action`'s approval): open to `@nestjs/authorization`'s
  // global guard, which would deny a method that declares no `@Can()`. A `@Can()` the tool does
  // declare is still checked.
  markCanAnyone(execute);
  const descriptor: PropertyDescriptor = {
    value: execute,
    writable: true,
    configurable: true,
    enumerable: false,
  };
  NestAgentFunction({
    name: options.name,
    description: options.description,
    inputSchema: options.input as never,
  })(prototype, 'execute', descriptor);
  Object.defineProperty(prototype, 'execute', descriptor);
  return true;
}

/**
 * Runs an agent turn's call of an `@AiTool` through `@nestjs/ai` (`run` calls `AiTools.call`), and
 * answers what `execute()` itself answered or threw. `@nestjs/ai` turns a result into JSON for the
 * model and every error but an `HttpException` into "Internal server error"; the agent persists the
 * result, presents it (`present()`) and classifies the error (transient or not), so it takes them as
 * they were. A refusal the enhancers made before `execute()` ran (a guard's, a pipe's) is what the
 * call fails with; a result an interceptor answered instead of `execute()` (a cache) is `run`'s.
 */
export async function callThroughAgentFunction(
  ctx: AiToolCtx,
  run: () => Promise<unknown>,
): Promise<unknown> {
  const call: AgentCall = { ctx };
  let answered: unknown;
  try {
    answered = await calls.run(call, run);
  } catch (error) {
    if (call.error !== undefined) throw call.error.error;
    throw (error as { cause?: unknown }).cause ?? error;
  }
  return call.output !== undefined ? call.output.value : answered;
}

/**
 * `@nestjs/ai`'s `AgentFunctionContext`, as `AiTools.call` builds one: a tool call id, the messages
 * the model read, an abort signal and `reportProgress`. Only such a context marks a call of
 * `@nestjs/ai`'s own; the agent's `AiToolCtx` has none of `messages` / `reportProgress`.
 */
function isAgentFunctionContext(ctx: unknown): ctx is AgentFunctionContext {
  if (typeof ctx !== 'object' || ctx === null) return false;
  const candidate = ctx as Partial<Record<keyof AgentFunctionContext, unknown>>;
  return (
    typeof candidate.reportProgress === 'function' &&
    Array.isArray(candidate.messages) &&
    typeof candidate.toolCallId === 'string' &&
    !('actor' in candidate)
  );
}

/** The agent's actor for a call of `@nestjs/ai`'s own: its `user`, when it has an id. */
function actorOf(user: unknown): Actor {
  const candidate = (user ?? {}) as { id?: unknown; roles?: unknown; tenantRef?: unknown };
  return {
    id: candidate.id !== undefined ? String(candidate.id) : 'anonymous',
    ...(Array.isArray(candidate.roles) ? { roles: candidate.roles.map(String) } : {}),
    ...(typeof candidate.tenantRef === 'string' ? { tenantRef: candidate.tenantRef } : {}),
  };
}

/** An `AiToolCtx` for a call outside any turn: no thread, and nothing to push components into. */
function toolCtxOf(context: AgentFunctionContext, actor: Actor): AiToolCtx {
  let pushed = 0;
  return {
    actor,
    threadId: '',
    runId: '',
    requestId: context.toolCallId,
    toolCallId: context.toolCallId,
    ...(context.idempotencyKey !== undefined ? { idempotencyKey: context.idempotencyKey } : {}),
    abortSignal: context.signal,
    emitUi: async (_component, _props, options) => ({
      id: options?.id ?? `${context.toolCallId}:ui:${pushed++}`,
    }),
  };
}
