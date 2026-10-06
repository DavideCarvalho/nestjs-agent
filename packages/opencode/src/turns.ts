import {
  AGENT_CHAT_QUEUE,
  type AgentDepsFactory,
  type ChatQueueService,
} from '@dudousxd/nestjs-agent';
import {
  AGENT_DEPS_FACTORY,
  AGENT_MEMORY,
  AGENT_SINK,
  AGENT_SKILLS,
  AGENT_STORE,
  AGENT_TOOL_REGISTRY,
  type AgentRunInput,
  type AgentStore,
  type ApprovalRequirement,
  DefaultApprovalPolicy,
  type HumanReply,
  type MemoryConfig,
  type PromptContext,
  RUN_ENDED_BEFORE_TOOL_CALL,
  type ScopeContext,
  type SkillsConfig,
  type StoredMessage,
  type TokenStreamSink,
  type ToolRegistry,
  buildMemoryBlock,
  defaultScopeResolver,
  encodeStreamEvent,
  publishAgentRunFailed,
  releaseThreadRun,
  resolveMemoryDigest,
  resolveSkillCatalog,
} from '@dudousxd/nestjs-agent-core';
import { Inject, Injectable, Logger, type OnApplicationShutdown, Optional } from '@nestjs/common';
import type { OpenCodeClient, OpenCodePermissionRule } from './client.js';
import { OpenCodeEventHub } from './event-hub.js';
import type { OpenCodeHost, OpenCodeServer, OpenCodeSessionStore } from './host.js';
import { OPENCODE_HOST, OPENCODE_OPTIONS, OPENCODE_SESSIONS } from './tokens.js';
import { type Milestone, OpenCodeTurn, type PendingAsk, type TurnOutcome } from './turn.js';

/** The module's `@AiTool`s, served to sessions over MCP (`@dudousxd/nestjs-agent-mcp-server`). */
export interface OpenCodeToolsOptions {
  /**
   * The URL OpenCode reaches the app's MCP endpoint at (`AgentMcpServerModule`, mounted with
   * `actions: 'execute'` — OpenCode's `ask` rules put the person in front of every `action` tool).
   */
  url: string;
  /** Headers authenticating the session as the turn's actor (e.g. a short-lived bearer token). */
  headers?: (
    actor: AgentRunInput['actor'],
  ) => Record<string, string> | Promise<Record<string, string>>;
  /** The MCP server's name in OpenCode; its tools are `<server>.<tool>` / `<server>_<tool>`. Default `'aviary'`. */
  server?: string;
}

export interface OpenCodeEngineSettings {
  /** How many earlier messages a NEW session is told about (a thread whose session was lost). Default 20. */
  historyMessages?: number;
  /** The instructions key the agent's own prompt is put under. Default `'aviary.system'`. */
  systemKey?: string;
  /** Serve the module's `@AiTool`s to the sessions. Omit → the session has the host's tools only. */
  tools?: OpenCodeToolsOptions;
  /** Where skills are written, relative to the session's directory. Default `'.opencode/skills'`. */
  skillsDir?: string;
  /**
   * How long `observe` waits for a milestone before failing the turn. Default 30 minutes. A turn
   * parked on a person is not observing: this bounds one stretch of OpenCode working on its own.
   */
  turnTimeoutMs?: number;
}

/** A thread's session, as the steps of a turn pass it along (and a durable run journals it). */
export interface SessionHandle {
  sessionId: string;
  serverKey: string;
  bootId?: string;
  directory?: string;
}

interface LiveTurn {
  turn: OpenCodeTurn;
  handle: SessionHandle;
  client: OpenCodeClient;
  stop: () => void;
}

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;

/**
 * The steps of an OpenCode turn — `begin` (thread, session, instructions), `prompt`, `observe`
 * (until a person is asked something or the execution ends), `reply`, `settle` — so an in-memory
 * runner can run them in a row and a durable one can checkpoint each. A step may run in a process
 * that did not run the one before (a durable run resumed elsewhere): the live turn is rebuilt from
 * the session, catching up on what OpenCode asked while nobody listened.
 */
@Injectable()
export class OpenCodeTurns implements OnApplicationShutdown {
  private readonly logger = new Logger('OpenCodeTurns');
  private readonly events = new OpenCodeEventHub();
  private readonly live = new Map<string, LiveTurn>();

  constructor(
    @Inject(OPENCODE_HOST) private readonly host: OpenCodeHost,
    @Inject(OPENCODE_SESSIONS) private readonly sessions: OpenCodeSessionStore,
    @Inject(OPENCODE_OPTIONS) private readonly settings: OpenCodeEngineSettings,
    @Inject(AGENT_STORE) private readonly store: AgentStore,
    @Inject(AGENT_SINK) private readonly sink: TokenStreamSink,
    @Inject(AGENT_DEPS_FACTORY) private readonly deps: AgentDepsFactory,
    @Inject(AGENT_TOOL_REGISTRY) private readonly registry: ToolRegistry,
    @Optional() @Inject(AGENT_SKILLS) private readonly skills?: SkillsConfig,
    @Optional() @Inject(AGENT_MEMORY) private readonly memory?: MemoryConfig,
    @Optional() @Inject(AGENT_CHAT_QUEUE) private readonly queue?: ChatQueueService,
  ) {}

  onApplicationShutdown(): void {
    for (const live of this.live.values()) live.stop();
    this.live.clear();
    this.events.close();
  }

  // ---- begin ---------------------------------------------------------------------------------

  /**
   * Persist the user message (or rewind the thread for a regenerate), find or create the thread's
   * session, and refresh what the session is told this turn.
   */
  async begin(runId: string, input: AgentRunInput): Promise<SessionHandle> {
    const earlier = await this.prepareThread(runId, input);
    const server = await this.host.server(input.actor);
    const known = await this.sessions.get(input.threadId);
    let handle: SessionHandle;
    if (known !== null && known.serverKey === server.key && known.bootId === server.bootId) {
      handle = known;
      if (input.regenerate === true) await this.revertLastExchange(server.client, handle.sessionId);
    } else {
      handle = await this.createSession(runId, input, server, earlier);
    }
    await this.refreshInstructions(runId, input, server.client, handle.sessionId);
    return handle;
  }

  private async createSession(
    runId: string,
    input: AgentRunInput,
    server: OpenCodeServer,
    earlier: StoredMessage[],
    note?: string,
  ): Promise<SessionHandle> {
    const { client } = server;
    const context = { input, runId };
    const spec = await this.host.session(context);
    const directory = spec.location?.directory;
    const skills = await this.writeSkills(input, client, directory);
    const sessionId = (
      await client.session.create({
        ...spec,
        permissions: [
          ...(spec.permissions ?? []),
          ...this.toolRules(input),
          ...skills.map(
            (name): OpenCodePermissionRule => ({
              action: 'skill',
              resource: name,
              effect: 'allow',
            }),
          ),
        ],
        metadata: { ...(spec.metadata ?? {}), threadId: input.threadId },
      })
    ).id;
    const handle: SessionHandle = {
      sessionId,
      serverKey: server.key,
      ...(server.bootId !== undefined ? { bootId: server.bootId } : {}),
      ...(directory !== undefined ? { directory } : {}),
    };
    await this.sessions.set(input.threadId, handle);
    await this.addTools(input, client, directory);
    await this.host.prepare?.({ ...context, sessionId, client });
    const transcript = transcriptOf(earlier, this.settings.historyMessages ?? 20);
    if (transcript || note) {
      await client.session.instructions.entry.put({
        sessionID: sessionId,
        key: 'aviary.history',
        value: [
          transcript
            ? `The conversation so far (continue it; do not repeat it):\n${transcript}`
            : '',
          note ?? '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      });
    }
    return handle;
  }

  /** The user message, as the loop persists it (or, on a regenerate, the thread rewound to it). */
  private async prepareThread(runId: string, input: AgentRunInput): Promise<StoredMessage[]> {
    const thread = await this.store.getThread(input.threadId);
    const messages = thread?.messages ?? [];
    if (input.regenerate === true) {
      let lastUser = -1;
      for (let i = messages.length - 1; i >= 0; i -= 1)
        if (messages[i]?.role === 'user') {
          lastUser = i;
          break;
        }
      const firstDropped = messages[lastUser + 1];
      if (firstDropped !== undefined)
        await this.store.truncateFrom(input.threadId, firstDropped.id);
      return messages.slice(0, Math.max(lastUser, 0));
    }
    await this.store.appendMessage({
      threadId: input.threadId,
      role: 'user',
      content: input.userText,
      runId,
      ...(input.persona !== undefined ? { persona: input.persona } : {}),
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
    });
    if (thread !== null && (thread.title === '' || thread.title === 'New chat')) {
      await this.store.setTitle(input.threadId, titleOf(input.userText));
    }
    return messages;
  }

  /** Rewind the session to before its last user message, so the regenerated answer replaces it. */
  private async revertLastExchange(client: OpenCodeClient, sessionId: string): Promise<void> {
    if (client.message === undefined || client.session.revert === undefined) return;
    const page = await client.message.list({ sessionID: sessionId, order: 'desc', limit: 50 });
    const last = page.data.find((m) => m.type === 'user');
    if (last === undefined) return;
    await client.session.revert.stage({ sessionID: sessionId, messageID: last.id, files: false });
    await client.session.revert.commit({ sessionID: sessionId });
  }

  /** The agent's prompt, the memory block and the host's entries — refreshed every turn. */
  private async refreshInstructions(
    runId: string,
    input: AgentRunInput,
    client: OpenCodeClient,
    sessionId: string,
  ): Promise<void> {
    const memory = await this.memoryBlock(input);
    const entries: Record<string, string> = {
      [this.settings.systemKey ?? 'aviary.system']: await this.systemPrompt(input),
      ...(memory !== undefined ? { 'aviary.memory': memory } : {}),
      ...((await this.host.instructions?.({ input, runId, sessionId })) ?? {}),
    };
    for (const [key, value] of Object.entries(entries)) {
      await client.session.instructions.entry.put({ sessionID: sessionId, key, value });
    }
  }

  /** The agent's base prompt (`@Agent({ systemPrompt })` / `@SystemPrompt()`) and the contributors. */
  private async systemPrompt(input: AgentRunInput): Promise<string> {
    const deps = this.deps.forAgent(input.agentName);
    const ctx: PromptContext = {
      actor: input.actor,
      agentName: input.agentName ?? 'default',
      ...(input.pageContext !== undefined ? { pageContext: input.pageContext } : {}),
      ...(input.uiCapabilities !== undefined ? { uiCapabilities: input.uiCapabilities } : {}),
    };
    const base =
      typeof deps.systemPrompt === 'function' ? await deps.systemPrompt(ctx) : deps.systemPrompt;
    const sections = [base];
    for (const contribute of deps.promptContributors) {
      const section = await contribute(ctx);
      if (section) sections.push(section);
    }
    return sections.filter(Boolean).join('\n\n');
  }

  private scopeContext(input: AgentRunInput): ScopeContext {
    return {
      actor: input.actor,
      threadId: input.threadId,
      ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
      ...(input.pageContext !== undefined ? { pageContext: input.pageContext } : {}),
    };
  }

  /** What is on file about the actor (`forRoot({ memory })`), read-only: OpenCode has no `remember`. */
  private async memoryBlock(input: AgentRunInput): Promise<string | undefined> {
    const memory = this.memory;
    if (memory === undefined) return undefined;
    const ctx = this.scopeContext(input);
    const scopes = await (memory.scopes ?? defaultScopeResolver).resolve(ctx);
    const records = await memory.provider.list({ scopes, ctx });
    const digest = resolveMemoryDigest({
      records,
      scopes,
      ...(memory.maxMemories !== undefined ? { maxMemories: memory.maxMemories } : {}),
    });
    if (digest.entries.length === 0) return undefined;
    return buildMemoryBlock({
      entries: digest.entries,
      writable: false,
      partial: digest.omitted > 0,
    });
  }

  /**
   * The module's skills (`forRoot({ skills })` / `@Skill`) as `SKILL.md` files under the session's
   * directory, where OpenCode's own `skill` tool finds them. Returns the names written.
   */
  private async writeSkills(
    input: AgentRunInput,
    client: OpenCodeClient,
    directory: string | undefined,
  ): Promise<string[]> {
    const skills = this.skills;
    if (skills === undefined || client.file === undefined || directory === undefined) return [];
    const ctx = this.scopeContext(input);
    const scopes = await (skills.scopes ?? defaultScopeResolver).resolve(ctx);
    const summaries = await skills.provider.list({ scopes, ctx });
    const { entries } = resolveSkillCatalog(summaries, scopes, skills.maxSkills);
    const dir = this.settings.skillsDir ?? '.opencode/skills';
    const written: string[] = [];
    for (const entry of entries) {
      const body = await skills.provider.load({ name: entry.name, scope: entry.scope, ctx });
      if (body === null) continue;
      const file = `---\nname: ${entry.name}\ndescription: ${JSON.stringify(entry.description)}\n---\n\n${body}\n`;
      await client.file.write({
        location: { directory },
        path: `${dir}/${entry.name}/SKILL.md`,
        payload: new TextEncoder().encode(file),
      });
      written.push(entry.name);
    }
    return written;
  }

  /** Permission rules for the module's tools: `read` allowed, `action` asked (→ an approval card). */
  private toolRules(input: AgentRunInput): OpenCodePermissionRule[] {
    const tools = this.settings.tools;
    if (tools === undefined) return [];
    const server = tools.server ?? 'aviary';
    const allow = this.deps.forAgent(input.agentName).toolAllowList;
    return this.registry
      .allSpecs()
      .filter((spec) => spec.kind === 'read' || spec.kind === 'action')
      .filter((spec) => allow === undefined || allow.includes(spec.name))
      .flatMap((spec) =>
        [`${server}.${spec.name}`, `${server}_${spec.name}`].map(
          (action): OpenCodePermissionRule => ({
            action,
            resource: '*',
            effect: spec.kind === 'action' ? 'ask' : 'allow',
          }),
        ),
      );
  }

  private async addTools(
    input: AgentRunInput,
    client: OpenCodeClient,
    directory: string | undefined,
  ): Promise<void> {
    const tools = this.settings.tools;
    if (tools === undefined) return;
    if (client.mcp === undefined) {
      this.logger.warn('`tools` is set but the OpenCode client cannot add MCP servers (`mcp.add`)');
      return;
    }
    await client.mcp.add({
      server: tools.server ?? 'aviary',
      ...(directory !== undefined ? { location: { directory } } : {}),
      config: {
        type: 'remote',
        url: tools.url,
        headers: (await tools.headers?.(input.actor)) ?? {},
        oauth: false,
      },
    });
  }

  // ---- prompt / observe / reply --------------------------------------------------------------

  /** Start listening to the session (so nothing it says is missed), then send the user message. */
  async prompt(runId: string, input: AgentRunInput, handle: SessionHandle): Promise<void> {
    const live = await this.ensureLive(runId, input, handle, false);
    try {
      await live.client.session.prompt({
        sessionID: handle.sessionId,
        text: input.userText,
        ...(input.attachments?.length && this.host.files
          ? { files: await this.host.files({ input, runId }) }
          : {}),
      });
    } catch (error) {
      live.turn.fail(`OpenCode refused the message: ${(error as Error).message}`);
    }
  }

  /**
   * Wait for the turn's next milestone. In a process that was not following the turn (a resumed
   * durable run), the turn is rebuilt and first catches up on requests OpenCode raised meanwhile;
   * `session.wait` is the safety net for a terminal event that was missed.
   */
  async observe(runId: string, input: AgentRunInput, handle: SessionHandle): Promise<Milestone> {
    const live = await this.ensureLive(runId, input, handle, true);
    const { turn, client } = live;
    if (turn.hasMilestone()) return turn.next();
    // Set once this observation has its milestone: the safety nets below only act while it waits.
    let done = false;
    const next = turn.next().then((milestone) => {
      done = true;
      return milestone;
    });
    const timeoutMs = this.settings.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (!done) turn.fail('Timed out waiting for OpenCode.');
    }, timeoutMs);
    timer.unref?.();
    if (client.session.wait !== undefined) {
      void client.session
        .wait({ sessionID: handle.sessionId })
        .then(() => new Promise((resolve) => setTimeout(resolve, 2_000)))
        .then(async () => {
          if (done || turn.finished) return;
          await turn.catchUp().catch(() => undefined);
          // Let a milestone the catch-up reached settle this observation first.
          await new Promise((resolve) => setImmediate(resolve));
          // Idle with nothing open: the execution ended while its last events were lost.
          if (!done && !turn.finished)
            turn.handle({
              type: 'session.execution.succeeded',
              data: { sessionID: handle.sessionId },
            });
        })
        .catch(() => undefined);
    }
    try {
      return await next;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Hand a person's answer back to OpenCode. When the server restarted while the turn waited, the
   * request is gone with it: a new session is opened, told what the person decided, and prompted
   * to go on.
   */
  async reply(
    runId: string,
    input: AgentRunInput,
    handle: SessionHandle,
    ask: PendingAsk,
    reply: HumanReply,
  ): Promise<SessionHandle> {
    const server = await this.host.server(input.actor);
    if (server.key !== handle.serverKey || server.bootId !== handle.bootId) {
      return this.continueAfterRestart(runId, input, server, ask, reply);
    }
    const live = await this.ensureLive(runId, input, handle, false);
    await live.turn.decide(ask, reply);
    return handle;
  }

  private async continueAfterRestart(
    runId: string,
    input: AgentRunInput,
    server: OpenCodeServer,
    ask: PendingAsk,
    reply: HumanReply,
  ): Promise<SessionHandle> {
    const approved = 'approved' in reply && reply.approved === true;
    const note =
      ask.kind === 'approval'
        ? approved
          ? `The user approved the action ${ask.action} you asked permission for. Continue the task.`
          : `The user did not approve the action ${ask.action}. Continue without it and explain.`
        : `The user answered your question: ${JSON.stringify('answers' in reply ? reply.answers : {})}. Continue.`;
    const thread = await this.store.getThread(input.threadId);
    const handle = await this.createSession(runId, input, server, thread?.messages ?? [], note);
    await this.refreshInstructions(runId, input, server.client, handle.sessionId);
    this.drop(runId);
    const live = await this.ensureLive(runId, input, handle, false);
    // The old request's card settles as decided; OpenCode is told in the note.
    await live.turn.decide(ask, reply, { tellOpenCode: false });
    await live.client.session.prompt({ sessionID: handle.sessionId, text: note });
    return handle;
  }

  /** Interrupt the thread's session (cancel). */
  async interrupt(input: AgentRunInput): Promise<void> {
    const known = await this.sessions.get(input.threadId);
    if (known === null) return;
    const server = await this.host.server(input.actor);
    if (server.key !== known.serverKey || server.bootId !== known.bootId) return;
    await server.client.session.interrupt({ sessionID: known.sessionId });
  }

  private async ensureLive(
    runId: string,
    input: AgentRunInput,
    handle: SessionHandle,
    catchUp: boolean,
  ): Promise<LiveTurn> {
    const current = this.live.get(runId);
    if (current !== undefined && current.handle.sessionId === handle.sessionId) return current;
    current?.stop();
    const server = await this.host.server(input.actor);
    const deps = this.deps.forAgent(input.agentName);
    const policy = deps.approvalPolicy ?? new DefaultApprovalPolicy();
    const writer = await this.sink.open(input.sinkRunId ?? runId);
    const turn = new OpenCodeTurn({
      runId,
      input,
      client: server.client,
      sessionId: handle.sessionId,
      writer,
      store: this.store,
      approvalFor: async (action): Promise<ApprovalRequirement> =>
        policy.requirementFor({ name: action, kind: 'action' }, input.actor, {
          threadId: input.threadId,
          runId,
          ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
        }),
      modelLabel: input.model ?? 'opencode',
      logger: this.logger,
    });
    const stop = await this.events.listen(server.key, server.client, handle.sessionId, (event) =>
      turn.handle(event),
    );
    const live: LiveTurn = { turn, handle, client: server.client, stop };
    this.live.set(runId, live);
    if (catchUp && current === undefined) await turn.catchUp().catch(() => undefined);
    return live;
  }

  /** Stop following a run in this process. */
  drop(runId: string): void {
    this.live.get(runId)?.stop();
    this.live.delete(runId);
  }

  // ---- settle --------------------------------------------------------------------------------

  /** End the run's stream and bookkeeping for how its execution ended. */
  async settle(runId: string, input: AgentRunInput, outcome: TurnOutcome, durationMs: number) {
    this.drop(runId);
    if (outcome.status === 'failed') {
      await this.settleFailed(runId, input, outcome.error);
      return;
    }
    const writer = await this.sink.open(runId);
    if (outcome.status === 'interrupted') {
      this.logger.log(`agent run ${runId} cancelled`);
      await Promise.resolve(
        this.store.failUnsettledToolCalls?.(runId, RUN_ENDED_BEFORE_TOOL_CALL),
      ).catch(() => 0);
      await this.handoff(writer, input, runId, 'cancelled');
      await releaseThreadRun(this.store, input.threadId, runId);
      await writer.write(encodeStreamEvent({ kind: 'cancelled' }));
      await writer.end();
      await this.store.recordRunEnd?.({ runId, status: 'cancelled', durationMs });
      return;
    }
    await this.handoff(writer, input, runId, 'completed');
    await releaseThreadRun(this.store, input.threadId, runId);
    await writer.end();
    await this.store.recordRunEnd?.({ runId, status: 'completed', durationMs });
  }

  async settleFailed(runId: string, input: AgentRunInput, message: string): Promise<void> {
    this.drop(runId);
    this.logger.error(`agent run ${runId} failed: ${message}`);
    publishAgentRunFailed({ runId, code: 'opencode_failed', message });
    await this.store.recordRunEnd?.({
      runId,
      status: 'failed',
      errorCode: 'opencode_failed',
      errorMessage: message,
    });
    await Promise.resolve(
      this.store.failUnsettledToolCalls?.(runId, RUN_ENDED_BEFORE_TOOL_CALL),
    ).catch(() => 0);
    const writer = await this.sink.open(runId);
    await this.handoff(writer, input, runId, 'failed', message);
    await releaseThreadRun(this.store, input.threadId, runId);
    await writer.fail({ code: 'opencode_failed', message });
  }

  /** Starts the next queued message of the thread; set by the runner (it owns `start`). */
  startNext: ((next: AgentRunInput, runId: string) => Promise<unknown>) | undefined;

  /** As `InlineAgentRunner`: hand the thread to its next queued message, and say so on the stream. */
  private async handoff(
    writer: { write(chunk: Uint8Array): void | Promise<void> },
    input: AgentRunInput,
    runId: string,
    outcome: 'completed' | 'failed' | 'cancelled',
    error?: string,
  ): Promise<void> {
    const queue = this.queue;
    const startNext = this.startNext;
    if (queue === undefined || !queue.supported || startNext === undefined) return;
    if (input.sinkRunId !== undefined || input.deliverTo !== undefined) return;
    try {
      const frame = await queue.handoff(
        { threadId: input.threadId, runId, outcome, ...(error !== undefined ? { error } : {}) },
        (next, nextRunId) => startNext(next, nextRunId),
      );
      if (frame !== undefined) await writer.write(encodeStreamEvent(frame));
    } catch (failure) {
      this.logger.error(
        `could not advance the queue of thread ${input.threadId} after run ${runId}: ${
          failure instanceof Error ? failure.message : String(failure)
        }`,
      );
    }
  }
}

function titleOf(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed || 'New chat';
}

function transcriptOf(messages: StoredMessage[], limit: number): string {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
    .slice(-limit)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 2000)}`)
    .join('\n');
}
