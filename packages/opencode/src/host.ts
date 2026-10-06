import type { Actor, AgentRunInput } from '@dudousxd/nestjs-agent-core';
import type { OpenCodeClient, OpenCodeSessionCreate } from './client.js';

/**
 * Where a turn runs and how its OpenCode session is set up — the part only the host knows. The
 * engine owns everything between the library and OpenCode (sessions per thread, the event stream,
 * the turn's frames, approvals and questions, cancel); the host answers these questions.
 */
export interface OpenCodeHost {
  /**
   * The OpenCode server this actor's turns run on — one per tenant in a sandbox, one for the whole
   * deployment, anything. Asked once per turn, so a server that restarted is picked up.
   */
  server(actor: Actor): Promise<OpenCodeServer>;

  /**
   * How to create a session for a thread: location, model, OpenCode agent, permission rules.
   * Asked only when the thread has no live session on this server (its first turn, or the server
   * restarted since). `input.model` is the model the caller picked for this turn, when it picked one.
   */
  session(context: OpenCodeTurnContext): Promise<OpenCodeSessionCreate>;

  /**
   * Instructions entries refreshed on every turn (key → text), on top of the agent's own prompt
   * (`@SystemPrompt` and the contributors, under `aviary.system`). Profile, memories, the project
   * a chat is about… An entry that disappears is not cleared: put an empty value to drop it.
   */
  instructions?(
    context: OpenCodeTurnContext & { sessionId: string },
  ): Promise<Record<string, string>>;

  /**
   * The user message's attachments (`input.attachments`) in the form `session.prompt` takes them.
   * Omit → attachments are not sent to OpenCode.
   */
  files?(context: OpenCodeTurnContext): Promise<unknown[]>;

  /**
   * Anything else to do on a NEW session before its first prompt — register MCP servers
   * (`client.mcp.add`), write skill files… Runs right after `session` and before `instructions`.
   */
  prepare?(
    context: OpenCodeTurnContext & { sessionId: string; client: OpenCodeClient },
  ): Promise<void>;
}

export interface OpenCodeServer {
  client: OpenCodeClient;
  /** Identifies the server across turns; sessions are only reused on the server that holds them. */
  key: string;
  /**
   * Changes whenever the server restarts and loses its sessions (a sandbox boot id). Omit for a
   * server whose sessions outlive restarts.
   */
  bootId?: string;
}

export interface OpenCodeTurnContext {
  input: AgentRunInput;
  runId: string;
}

/** The session a thread talks to, and where it lives. */
export interface OpenCodeSessionRef {
  sessionId: string;
  serverKey: string;
  bootId?: string;
}

/**
 * Which OpenCode session each thread uses. The default keeps it in memory, which is enough for one
 * process; a deployment with several replicas (or that wants sessions to survive a restart of its
 * own) persists it — on the thread row, typically.
 */
export interface OpenCodeSessionStore {
  get(threadId: string): Promise<OpenCodeSessionRef | null>;
  set(threadId: string, ref: OpenCodeSessionRef): Promise<void>;
}

export class InMemoryOpenCodeSessionStore implements OpenCodeSessionStore {
  private readonly refs = new Map<string, OpenCodeSessionRef>();

  async get(threadId: string): Promise<OpenCodeSessionRef | null> {
    return this.refs.get(threadId) ?? null;
  }

  async set(threadId: string, ref: OpenCodeSessionRef): Promise<void> {
    this.refs.set(threadId, ref);
  }
}
