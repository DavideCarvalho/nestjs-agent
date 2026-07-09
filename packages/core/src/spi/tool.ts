import type { Actor, PageContext } from '../types.js';

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
  /** The name of the agent running this turn — provenance a tool can scope on (e.g. capability sets). */
  agentName?: string;
  pageContext?: PageContext;
  /** Optional host handle (e.g. an ORM EntityManager) the app threads through options. */
  host?: unknown;
}

/** A tool implementation. `I` is the parsed (Zod-validated) input. */
export interface ToolHandler<I = unknown> {
  execute(input: I, ctx: AiToolCtx): Promise<unknown>;
}
