import type {
  OpenCodeClient,
  OpenCodeEvent,
  OpenCodeForm,
  OpenCodeJson,
  OpenCodeMessage,
  OpenCodeMessagePart,
  OpenCodePermissionRequest,
  OpenCodePromptFile,
  OpenCodeSessionCreate,
  OpenCodeTokens,
} from '../client.js';

export interface FakeCall {
  method: string;
  args: Record<string, unknown>;
}

/** What the fake does when a session is prompted: emit events, wait for replies, emit more. */
export type FakeScript = (turn: FakeTurn) => Promise<void>;

export interface FakeTurn {
  sessionId: string;
  text: string;
  emit(type: string, data?: Record<string, unknown>): void;
  /** Emit an event nobody hears (the API was down); the session's messages still record it. */
  unheard(type: string, data?: Record<string, unknown>): void;
  /** Resolves with the next call of `method` on this session (e.g. `permission.reply`). */
  next(method: string): Promise<FakeCall>;
  /** Ends the execution: `session.execution.succeeded`. */
  succeed(): void;
}

/**
 * An OpenCode 2 server in memory, shaped after the v2 API the engine calls: sessions, prompts that
 * run a script of events, permission and form replies, interrupts, and one event stream for every
 * session. Every call is recorded in `calls`.
 */
export class FakeOpenCode implements OpenCodeClient {
  readonly calls: FakeCall[] = [];
  private readonly listeners = new Set<(event: OpenCodeEvent) => void>();
  private readonly waiters: Array<{
    method: string;
    sessionId: string;
    resolve: (c: FakeCall) => void;
  }> = [];
  private sessions = 0;
  private readonly metadata = new Map<string, OpenCodeSessionCreate['metadata']>();
  /** Permission requests and forms asked and not answered yet (what `list` reports). */
  readonly openPermissions = new Map<string, OpenCodePermissionRequest>();
  readonly openForms = new Map<string, OpenCodeForm>();
  /**
   * Each session's messages, oldest first, as OpenCode records them from the events it emits: the
   * prompts, one assistant message per step (its text, reasoning and tool parts, its usage) and an
   * `idle` where an execution ended — what `message.list` reports.
   */
  readonly messages = new Map<string, OpenCodeMessage[]>();
  /** The assistant message each session's step is writing, until `session.step.ended`. */
  private readonly writing = new Map<string, OpenCodeMessage>();
  private messageCount = 0;
  private readonly idleWaiters: Array<() => void> = [];
  private idle = false;
  /**
   * How long a subscription takes to reach the server after the stream is first iterated (the
   * request's round trip). Events emitted before then are not delivered to it — as with OpenCode.
   */
  connectDelayMs = 0;
  /** What each session spent so far, as `session.get` reports it (set by a test). */
  readonly usage = new Map<string, { cost: number; tokens: OpenCodeTokens }>();

  /** The sessions go idle: `session.wait` resolves (until the next prompt). */
  goIdle(): void {
    this.idle = true;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  constructor(
    public script: FakeScript = async (t) => {
      t.emit('session.text.delta', { delta: `echo: ${t.text}` });
      t.emit('session.step.ended', { tokens: { input: 10, output: 5 } });
      t.succeed();
    },
  ) {}

  private record(method: string, args: Record<string, unknown>): void {
    const call = { method, args };
    this.calls.push(call);
    const sessionId = String(args.sessionID ?? '');
    const index = this.waiters.findIndex((w) => w.method === method && w.sessionId === sessionId);
    if (index >= 0) {
      const [waiter] = this.waiters.splice(index, 1);
      waiter?.resolve(call);
    }
  }

  callsOf(method: string): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  emit(event: OpenCodeEvent): void {
    this.recordMessage(event);
    if (event.type === 'permission.asked') {
      this.openPermissions.set(String(event.data.id), event.data as OpenCodePermissionRequest);
    }
    if (event.type === 'form.created') {
      const form = (event.data.form ?? event.data) as OpenCodeForm;
      this.openForms.set(form.id, form);
    }
    for (const listener of this.listeners) listener(event);
  }

  private messagesOf(sessionId: string): OpenCodeMessage[] {
    let list = this.messages.get(sessionId);
    if (list === undefined) {
      list = [];
      this.messages.set(sessionId, list);
    }
    return list;
  }

  /** The assistant message an event of a step belongs to: the one being written, else a new one. */
  private assistantOf(sessionId: string, toolId?: string): OpenCodeMessage {
    const list = this.messagesOf(sessionId);
    // A tool settles on the message that called it, even after that step ended.
    if (toolId !== undefined) {
      const caller = list.find((m) => m.content?.some((p) => p.type === 'tool' && p.id === toolId));
      if (caller !== undefined) return caller;
    }
    let message = this.writing.get(sessionId);
    if (message === undefined) {
      this.messageCount += 1;
      message = { id: `asst_${this.messageCount}`, type: 'assistant', content: [] };
      list.push(message);
      this.writing.set(sessionId, message);
    }
    return message;
  }

  /** Record what an event says on the session's messages, and name its assistant message. */
  private recordMessage(event: OpenCodeEvent): void {
    if (event.data === undefined || !event.type.startsWith('session.')) return;
    const data = event.data as Record<string, any>;
    const sessionId = data.sessionID;
    if (typeof sessionId !== 'string') return;
    const part = (message: OpenCodeMessage, type: string, open: boolean) => {
      const parts = message.content ?? [];
      message.content = parts;
      const last = parts.at(-1) as (OpenCodeMessagePart & { open?: boolean }) | undefined;
      if (last?.type === type && last.open === true) return last;
      const created: OpenCodeMessagePart & { open?: boolean } = { type, text: '', open };
      parts.push(created);
      return created;
    };
    const tool = (message: OpenCodeMessage, id: string, name?: string) => {
      const parts = message.content ?? [];
      message.content = parts;
      let found = parts.find((p) => p.type === 'tool' && p.id === id);
      if (found === undefined) {
        found = {
          type: 'tool',
          id,
          name: name ?? 'tool',
          state: { status: 'streaming', input: '' },
        };
        parts.push(found);
      }
      return found;
    };
    const stamp = (message: OpenCodeMessage) => {
      data.assistantMessageID ??= message.id;
    };
    switch (event.type) {
      case 'session.step.started': {
        this.writing.delete(sessionId);
        const message = this.assistantOf(sessionId);
        if (data.model !== undefined) message.model = data.model;
        stamp(message);
        return;
      }
      case 'session.text.delta':
      case 'session.reasoning.delta': {
        const message = this.assistantOf(sessionId);
        stamp(message);
        const kind = event.type === 'session.text.delta' ? 'text' : 'reasoning';
        const p = part(message, kind, true);
        p.text = `${p.text ?? ''}${String(data.delta ?? '')}`;
        return;
      }
      case 'session.text.ended': {
        const message = this.assistantOf(sessionId);
        stamp(message);
        const last = message.content?.at(-1) as { type: string; open?: boolean } | undefined;
        if (last?.type === 'text') last.open = false;
        return;
      }
      case 'session.tool.input.started':
      case 'session.tool.called':
      case 'session.tool.success':
      case 'session.tool.failed': {
        const id = String(data.id);
        const message = this.assistantOf(sessionId, id);
        stamp(message);
        const p = tool(message, id, typeof data.name === 'string' ? data.name : undefined);
        const input = (p.state as { input?: unknown }).input;
        if (event.type === 'session.tool.called')
          p.state = { status: 'running', input: data.input ?? {}, metadata: {} };
        if (event.type === 'session.tool.success')
          p.state = { status: 'completed', input, content: [{ type: 'text', text: 'ok' }] };
        if (event.type === 'session.tool.failed')
          p.state = {
            status: 'error',
            input,
            error: {
              type: 'error',
              message: String(data.error?.message ?? data.error ?? 'failed'),
            },
          };
        return;
      }
      case 'session.step.ended': {
        const message = this.assistantOf(sessionId);
        stamp(message);
        if (data.tokens !== undefined) message.tokens = data.tokens;
        if (typeof data.cost === 'number') message.cost = data.cost;
        this.writing.delete(sessionId);
        return;
      }
      case 'session.execution.succeeded':
      case 'session.execution.failed':
      case 'session.execution.interrupted':
        this.writing.delete(sessionId);
        this.messageCount += 1;
        this.messagesOf(sessionId).push({
          id: `idle_${this.messageCount}`,
          type: 'idle',
          outcome: event.type.slice('session.execution.'.length),
        });
        return;
      default:
        return;
    }
  }

  /** Raise an event without anyone hearing it — what OpenCode did while the API was down. */
  emitUnheard(event: OpenCodeEvent): void {
    const listeners = [...this.listeners];
    this.listeners.clear();
    this.emit(event);
    for (const listener of listeners) this.listeners.add(listener);
  }

  session = {
    create: async (args: OpenCodeSessionCreate) => {
      this.record('session.create', args as Record<string, unknown>);
      this.sessions += 1;
      const id = `ses_${this.sessions}`;
      this.metadata.set(id, args.metadata ?? {});
      return { id };
    },
    get: async (args: { sessionID: string }) => {
      this.record('session.get', args);
      return {
        id: args.sessionID,
        metadata: this.metadata.get(args.sessionID) ?? {},
        // A session that spent nothing yet reports zeros, as OpenCode does.
        ...(this.usage.get(args.sessionID) ?? {
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      };
    },
    prompt: async (args: {
      sessionID: string;
      text: string;
      files?: OpenCodePromptFile[];
      metadata?: { readonly [key: string]: OpenCodeJson };
    }) => {
      this.record('session.prompt', args);
      this.idle = false;
      const sessionId = args.sessionID;
      const messages = this.messagesOf(sessionId);
      const users = messages.filter((m) => m.type === 'user').length;
      this.writing.delete(sessionId);
      messages.push({
        id: `msg_${sessionId}_${users + 1}`,
        type: 'user',
        text: args.text,
        ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
      });
      const turn: FakeTurn = {
        sessionId,
        text: args.text,
        emit: (type, data = {}) => this.emit({ type, data: { sessionID: sessionId, ...data } }),
        unheard: (type, data = {}) =>
          this.emitUnheard({ type, data: { sessionID: sessionId, ...data } }),
        next: (method) =>
          new Promise((resolve) => this.waiters.push({ method, sessionId, resolve })),
        succeed: () =>
          this.emit({ type: 'session.execution.succeeded', data: { sessionID: sessionId } }),
      };
      // OpenCode answers the prompt at once and runs the execution in the background.
      void Promise.resolve().then(() => this.script(turn));
      return {};
    },
    interrupt: async (args: { sessionID: string }) => {
      this.record('session.interrupt', args);
      this.emit({ type: 'session.execution.interrupted', data: { sessionID: args.sessionID } });
      return {};
    },
    wait: async (args: { sessionID: string }) => {
      this.record('session.wait', args);
      if (!this.idle) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
      return {};
    },
    revert: {
      stage: async (args: { sessionID: string; messageID: string; files?: boolean }) => {
        this.record('session.revert.stage', args);
        return {};
      },
      commit: async (args: { sessionID: string }) => {
        this.record('session.revert.commit', args);
        return {};
      },
    },
    instructions: {
      entry: {
        put: async (args: { sessionID: string; key: string; value: string }) => {
          this.record('session.instructions.entry.put', args);
          return {};
        },
      },
    },
    form: {
      list: async (args: { sessionID: string }) =>
        [...this.openForms.values()].filter((f) => f.sessionID === args.sessionID),
      reply: async (args: {
        sessionID: string;
        formID: string;
        answer: Record<string, unknown>;
      }) => {
        this.openForms.delete(args.formID);
        this.record('session.form.reply', args);
        return {};
      },
      cancel: async (args: { sessionID: string; formID: string }) => {
        this.openForms.delete(args.formID);
        this.record('session.form.cancel', args);
        return {};
      },
    },
  };

  permission = {
    list: async (args: { sessionID: string }) =>
      [...this.openPermissions.values()].filter((p) => p.sessionID === args.sessionID),
    reply: async (args: {
      sessionID: string;
      requestID: string;
      decision: 'once' | 'reject';
      message?: string;
    }) => {
      this.openPermissions.delete(args.requestID);
      this.record('permission.reply', args);
      return {};
    },
  };

  message = {
    list: async (args: {
      sessionID: string;
      order?: 'asc' | 'desc';
      limit?: number;
      cursor?: string;
    }) => {
      this.record('message.list', args);
      // Copies with the bookkeeping (`open`) left out, as the API serializes them.
      const all: OpenCodeMessage[] = JSON.parse(
        JSON.stringify(this.messages.get(args.sessionID) ?? [], (key, value) =>
          key === 'open' ? undefined : value,
        ),
      );
      if (args.order === 'desc') all.reverse();
      const from = args.cursor !== undefined ? Number(args.cursor) : 0;
      const to = args.limit !== undefined ? from + args.limit : all.length;
      return {
        data: all.slice(from, to),
        cursor: { next: to < all.length ? String(to) : null },
      };
    },
  };

  mcp = {
    add: async (args: Parameters<NonNullable<OpenCodeClient['mcp']>['add']>[0]) => {
      this.record('mcp.add', args as unknown as Record<string, unknown>);
      return {};
    },
  };

  /** Files written, by path. */
  readonly files = new Map<string, string>();

  file = {
    write: async (args: {
      location?: { directory: string };
      path: string;
      payload: Uint8Array;
    }) => {
      this.record('file.write', { path: args.path, location: args.location });
      this.files.set(args.path, new TextDecoder().decode(args.payload));
      return {};
    },
  };

  event = {
    /**
     * As the real client: nothing happens until the stream is iterated; then the request reaches
     * the server (after {@link connectDelayMs}), which registers the subscriber and opens the stream
     * with `server.connected`. Only events emitted after that are delivered.
     */
    subscribe: (args: { signal: AbortSignal }): AsyncIterable<OpenCodeEvent> => {
      const fake = this;
      return {
        async *[Symbol.asyncIterator]() {
          const queue: OpenCodeEvent[] = [{ type: 'server.connected', data: {} }];
          let wake: (() => void) | undefined;
          const listener = (event: OpenCodeEvent) => {
            queue.push(event);
            wake?.();
          };
          if (fake.connectDelayMs > 0)
            await new Promise((resolve) => setTimeout(resolve, fake.connectDelayMs));
          if (args.signal.aborted) return;
          fake.listeners.add(listener);
          try {
            while (!args.signal.aborted) {
              const event = queue.shift();
              if (event !== undefined) {
                yield event;
                continue;
              }
              await new Promise<void>((resolve) => {
                wake = resolve;
                args.signal.addEventListener('abort', () => resolve(), { once: true });
              });
              wake = undefined;
            }
          } finally {
            fake.listeners.delete(listener);
          }
        },
      };
    },
  };
}
