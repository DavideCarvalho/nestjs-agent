import { randomUUID } from 'node:crypto';
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
  type AgentUiComponent,
  type AiToolCtx,
  type ApprovalRequirement,
  DEFAULT_MAX_FACT_CHARS,
  DefaultApprovalPolicy,
  type HumanReply,
  type MemoryConfig,
  type PromptContext,
  REMEMBER_TOOL_DESCRIPTION,
  REMEMBER_TOOL_NAME,
  RUN_ENDED_BEFORE_TOOL_CALL,
  type RememberToolInput,
  type ScopeContext,
  type SkillsConfig,
  type StoredMessage,
  type TokenStreamSink,
  type ToolRegistry,
  actorScope,
  buildMemoryBlock,
  defaultScopeResolver,
  encodeStreamEvent,
  memoryWriteVerdict,
  publishAgentRunFailed,
  releaseThreadRun,
  rememberInputSchema,
  resolveMemoryDigest,
  resolveSkillCatalog,
} from '@dudousxd/nestjs-agent-core';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import type { OpenCodeClient, OpenCodePermissionRule } from './client.js';
import { OpenCodeEventHub } from './event-hub.js';
import type {
  OpenCodeHost,
  OpenCodeRunResult,
  OpenCodeServer,
  OpenCodeSessionStore,
} from './host.js';
import { OPENCODE_HOST, OPENCODE_OPTIONS, OPENCODE_SESSIONS } from './tokens.js';
import {
  type Milestone,
  OpenCodeTurn,
  type PendingAsk,
  type TurnOutcome,
  errorText,
} from './turn.js';

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
  input: AgentRunInput;
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
export class OpenCodeTurns implements OnModuleInit, OnApplicationShutdown {
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

  /**
   * With the module's tools served over MCP and a memory provider that writes, OpenCode gets the
   * `remember` tool the loop would have offered: one fact, at the actor's own scope only.
   */
  onModuleInit(): void {
    if (!this.memoryWritable() || this.registry.has(REMEMBER_TOOL_NAME)) return;
    this.registry.register(
      {
        name: REMEMBER_TOOL_NAME,
        kind: 'read',
        description: REMEMBER_TOOL_DESCRIPTION,
        inputSchema: rememberInputSchema,
        roles: [],
      },
      { execute: (input, ctx) => this.remember(input as RememberToolInput, ctx) },
    );
  }

  private memoryWritable(): boolean {
    return this.settings.tools !== undefined && this.memory?.provider.write !== undefined;
  }

  private async remember(input: RememberToolInput, ctx: AiToolCtx): Promise<string> {
    const memory = this.memory;
    const write = memory?.provider.write?.bind(memory.provider);
    if (memory === undefined || write === undefined) return 'Memory is read-only here.';
    const max = memory.maxFactChars ?? DEFAULT_MAX_FACT_CHARS;
    if (input.fact.length > max) return `Not recorded: a fact is at most ${max} characters.`;
    const scopeCtx = {
      actor: ctx.actor,
      threadId: ctx.threadId,
      ...(ctx.agentName !== undefined ? { agentName: ctx.agentName } : {}),
    };
    const scopes = await (memory.scopes ?? defaultScopeResolver).resolve(scopeCtx);
    const scope = actorScope(ctx.actor);
    const verdict = memoryWriteVerdict({
      scope,
      scopes,
      actor: ctx.actor,
      author: { kind: 'agent' },
    });
    if (!verdict.allowed) return `Not recorded: ${verdict.reason}`;
    await write({
      key: input.key,
      text: input.fact,
      scope,
      origin: {
        author: 'agent',
        actorRef: ctx.actor.id,
        // An MCP call no turn claimed carries synthetic `mcp:` ids: provenance names real ones only.
        ...(ctx.threadId.startsWith('mcp:') ? {} : { threadId: ctx.threadId }),
        ...(ctx.runId.startsWith('mcp:') ? {} : { runId: ctx.runId }),
      },
      ctx: scopeCtx,
    });
    return `Recorded "${input.key}".`;
  }

  /**
   * The context of a tool call made over MCP by one of this engine's sessions — for
   * `AgentMcpServerModule`'s `context` option. OpenCode names its session in the call's `_meta`
   * (`ai.opencode/sessionID`); the call is then the turn's: its thread and run, and `ctx.emitUi`
   * pushes into the turn's stream and message. A session this process is not following is found
   * through OpenCode (`session.get` → the thread it was created for → the thread's running turn):
   * its components still reach the stream, as a message of their own.
   */
  async toolContext(input: {
    actor: AiToolCtx['actor'];
    requestId?: string;
    meta: Readonly<Record<string, unknown>> | undefined;
  }): Promise<Partial<Pick<AiToolCtx, 'threadId' | 'runId' | 'emitUi'>> | undefined> {
    const sessionId = sessionOfMeta(input.meta);
    if (sessionId === undefined) return undefined;
    // `_meta` is the client's to write: a session id ties the call to a turn only when the caller is
    // the person that turn runs for.
    const scope = (runId: string) => `${runId}:${input.requestId ?? randomUUID()}`;
    for (const [runId, live] of this.live) {
      if (live.handle.sessionId !== sessionId) continue;
      if (live.input.actor.id !== input.actor.id) return undefined;
      return {
        threadId: live.input.threadId,
        runId,
        emitUi: uiEmitter(scope(runId), async (component) => {
          await live.turn.pushUi(component);
          await this.uiPushed(live.input, runId, component);
        }),
      };
    }
    const threadId = await this.threadOfSession(input.actor, sessionId);
    if (threadId === undefined) return undefined;
    if ((await this.store.ownerOfThread(threadId)) !== input.actor.id) return undefined;
    const runId = (await this.store.activeRunForThread?.(threadId)) ?? null;
    if (runId === null) return { threadId };
    return {
      threadId,
      runId,
      emitUi: uiEmitter(scope(runId), async (component) => {
        const writer = await this.sink.open(runId);
        await writer.write(encodeStreamEvent({ kind: 'ui', ...component }));
        await this.store.appendMessage({
          threadId,
          role: 'assistant',
          content: '',
          runId,
          ui: [component],
        });
        // Followed elsewhere: the host gets what this call knows of the run.
        await this.uiPushed({ threadId, actor: input.actor, userText: '' }, runId, component);
      }),
    };
  }

  private async uiPushed(input: AgentRunInput, runId: string, component: AgentUiComponent) {
    await this.host.onUi?.({ input, runId, component }).catch((error: unknown) => {
      this.logger.warn(`onUi failed: ${errorText(error, 'error')}`);
    });
  }

  private async threadOfSession(
    actor: AiToolCtx['actor'],
    sessionId: string,
  ): Promise<string | undefined> {
    try {
      const server = await this.host.server(actor);
      const info = await server.client.session.get?.({ sessionID: sessionId });
      const threadId = info?.metadata?.threadId;
      return typeof threadId === 'string' ? threadId : undefined;
    } catch {
      return undefined;
    }
  }

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

  /** What is on file about the actor (`forRoot({ memory })`); writable when `remember` is served. */
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
      writable: this.memoryWritable(),
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

  /**
   * Permission rules for the module's tools: the MCP server allowed as a whole (OpenCode offers a
   * server's tools only when the server itself is allowed), then each `action` tool asked — the last
   * matching rule wins, so an action still lands on an approval card. Tools outside the agent's
   * allow-list are denied.
   */
  private toolRules(input: AgentRunInput): OpenCodePermissionRule[] {
    const tools = this.settings.tools;
    if (tools === undefined) return [];
    const server = tools.server ?? 'aviary';
    const allow = this.deps.forAgent(input.agentName).toolAllowList;
    const both = (name: string) => [`${server}.${name}`, `${server}_${name}`];
    const rules: OpenCodePermissionRule[] = [
      { action: `${server}*`, resource: '*', effect: 'allow' },
    ];
    for (const spec of this.registry.allSpecs()) {
      const offered = allow === undefined || allow.includes(spec.name);
      if (offered && spec.kind === 'read') continue;
      const effect = offered && spec.kind === 'action' ? 'ask' : 'deny';
      for (const action of both(spec.name)) rules.push({ action, resource: '*', effect });
    }
    return rules;
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
    if (turn.hasMilestone()) return this.reached(runId, input, handle, await turn.next());
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
      return await this.reached(runId, input, handle, await next);
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
    const live: LiveTurn = { turn, input, handle, client: server.client, stop };
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

  /** A person was asked something: tell the host (cards in other channels, wake-ups). */
  private async reached(
    runId: string,
    input: AgentRunInput,
    handle: SessionHandle,
    milestone: Milestone,
  ): Promise<Milestone> {
    if (milestone.kind === 'ask' && this.host.onAsk !== undefined) {
      await this.host
        .onAsk({ input, runId, sessionId: handle.sessionId, ask: milestone.ask })
        .catch((error: unknown) => this.logger.warn(`onAsk failed: ${errorText(error, 'error')}`));
    }
    return milestone;
  }

  /** What the run produced, as the host's settle hooks see it. */
  private async runResult(
    runId: string,
    input: AgentRunInput,
    outcome: TurnOutcome,
    durationMs: number,
  ): Promise<OpenCodeRunResult> {
    const thread = await this.store.getThread(input.threadId);
    const messages = (thread?.messages ?? []).filter(
      (m) => m.role === 'assistant' && m.runId === runId,
    );
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    for (const m of messages) {
      usage.inputTokens += m.usage?.inputTokens ?? 0;
      usage.outputTokens += m.usage?.outputTokens ?? 0;
      usage.costUsd += m.usage?.costUsd ?? 0;
    }
    return {
      runId,
      input,
      outcome,
      text: messages
        .map((m) => m.content)
        .filter(Boolean)
        .join('\n\n'),
      messages,
      usage,
      durationMs,
    };
  }

  /**
   * The host's last word on the answer before the stream ends: components to append (a guardrail
   * notice), or, for a failed run, the error the person reads instead of OpenCode's.
   */
  private async amend(
    writer: { write(chunk: Uint8Array): void | Promise<void> },
    result: OpenCodeRunResult,
  ) {
    const hook = this.host.beforeSettle;
    if (hook === undefined) return {};
    const amendment =
      (await hook(result).catch((error: unknown) => {
        this.logger.warn(`beforeSettle failed: ${errorText(error, 'error')}`);
        return undefined;
      })) ?? {};
    const ui = amendment.ui ?? [];
    const last = result.messages.at(-1);
    if (ui.length > 0) {
      for (const component of ui)
        await writer.write(encodeStreamEvent({ kind: 'ui', ...component }));
      if (last !== undefined) await this.store.setMessageUi?.(last.id, [...(last.ui ?? []), ...ui]);
    }
    return amendment;
  }

  /** Delivery, telemetry, spend: after the run settled. Errors are the host's, never the run's. */
  private async settled(result: OpenCodeRunResult): Promise<void> {
    await this.host.onSettled?.(result).catch((error: unknown) => {
      this.logger.warn(`onSettled failed: ${errorText(error, 'error')}`);
    });
  }

  /** End the run's stream and bookkeeping for how its execution ended. */
  async settle(runId: string, input: AgentRunInput, outcome: TurnOutcome, durationMs: number) {
    if (outcome.status === 'failed') {
      await this.settleFailed(runId, input, outcome.error, durationMs);
      return;
    }
    this.drop(runId);
    const writer = await this.sink.open(runId);
    const result = await this.runResult(runId, input, outcome, durationMs);
    await this.amend(writer, result);
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
    } else {
      await this.handoff(writer, input, runId, 'completed');
      await releaseThreadRun(this.store, input.threadId, runId);
      await writer.end();
      await this.store.recordRunEnd?.({ runId, status: 'completed', durationMs });
    }
    await this.settled(result);
  }

  async settleFailed(
    runId: string,
    input: AgentRunInput,
    error: string,
    durationMs = 0,
  ): Promise<void> {
    this.drop(runId);
    const writer = await this.sink.open(runId);
    const result = await this.runResult(runId, input, { status: 'failed', error }, durationMs);
    const message = (await this.amend(writer, result)).error ?? error;
    this.logger.error(`agent run ${runId} failed: ${error}`);
    publishAgentRunFailed({ runId, code: 'opencode_failed', message: error });
    await this.store.recordRunEnd?.({
      runId,
      status: 'failed',
      errorCode: 'opencode_failed',
      errorMessage: error,
    });
    await Promise.resolve(
      this.store.failUnsettledToolCalls?.(runId, RUN_ENDED_BEFORE_TOOL_CALL),
    ).catch(() => 0);
    await this.handoff(writer, input, runId, 'failed', message);
    await releaseThreadRun(this.store, input.threadId, runId);
    await writer.fail({ code: 'opencode_failed', message });
    await this.settled({ ...result, outcome: { status: 'failed', error: message } });
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

/** The `_meta` key OpenCode names its session with on every MCP call. */
const SESSION_META_KEY = 'ai.opencode/sessionID';

function sessionOfMeta(meta: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const value = meta?.[SESSION_META_KEY];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `ctx.emitUi` over `push`, with the library's id and snapshot rules. */
function uiEmitter(
  scope: string,
  push: (component: AgentUiComponent) => Promise<void>,
): AiToolCtx['emitUi'] {
  let next = 0;
  return async (component, props, options = {}) => {
    if (typeof component !== 'string' || component.length === 0) {
      throw new Error('emitUi: component must be a non-empty string');
    }
    if (typeof props !== 'object' || props === null || Array.isArray(props)) {
      throw new Error('emitUi: props must be a JSON object');
    }
    const id = options.id ?? `${scope}:ui:${next++}`;
    await push({
      id,
      component,
      props: JSON.parse(JSON.stringify(props)) as Record<string, unknown>,
      ...(options.version !== undefined ? { version: options.version } : {}),
    });
    return { id };
  };
}
