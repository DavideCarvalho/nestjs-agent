import type { Actor, PageContext, Persona } from '../types.js';

/** Per-invocation context handed to a tool handler. Host-supplied bits are optional. */
export interface AiToolCtx {
  actorId: string;
  actorRole?: string;
  tenantRef?: string;
  threadId: string;
  runId: string;
  requestId: string;
  persona?: Persona;
  pageContext?: PageContext;
  actor: Actor;
  /** Optional host handle (e.g. an ORM EntityManager) the app threads through options. */
  host?: unknown;
  /**
   * Delegate to another named agent and await its answer. Present only when the host wired
   * multi-agent support; under durable it runs the sub-agent as a child workflow, inline it runs
   * a nested loop. A tool uses this to build an orchestrator that talks to other agents.
   */
  runAgent?: (agentName: string, task: string) => Promise<{ text: string }>;
}

/** A tool implementation. `I` is the parsed (Zod-validated) input. */
export interface ToolHandler<I = unknown> {
  execute(input: I, ctx: AiToolCtx): Promise<unknown>;
}
