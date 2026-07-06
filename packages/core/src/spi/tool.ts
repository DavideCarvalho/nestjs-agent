import type { Actor, PageContext, Persona } from '../types.js';

/**
 * Per-invocation context handed to a tool handler. Host-supplied bits are optional. Identity lives
 * on {@link AiToolCtx.actor} — read `ctx.actor.id` / `ctx.actor.tenantRef` (single source of truth;
 * no denormalized copies).
 */
export interface AiToolCtx {
  actor: Actor;
  threadId: string;
  runId: string;
  requestId: string;
  persona?: Persona;
  pageContext?: PageContext;
  /** Optional host handle (e.g. an ORM EntityManager) the app threads through options. */
  host?: unknown;
}

/** A tool implementation. `I` is the parsed (Zod-validated) input. */
export interface ToolHandler<I = unknown> {
  execute(input: I, ctx: AiToolCtx): Promise<unknown>;
}
