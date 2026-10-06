import type { OpenCodeClient, OpenCodeEvent, OpenCodeSessionCreate } from '../client.js';

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
    for (const listener of this.listeners) listener(event);
  }

  session = {
    create: async (args: OpenCodeSessionCreate) => {
      this.record('session.create', args as Record<string, unknown>);
      this.sessions += 1;
      return { id: `ses_${this.sessions}` };
    },
    prompt: async (args: { sessionID: string; text: string; files?: unknown[] }) => {
      this.record('session.prompt', args);
      const sessionId = args.sessionID;
      const turn: FakeTurn = {
        sessionId,
        text: args.text,
        emit: (type, data = {}) => this.emit({ type, data: { sessionID: sessionId, ...data } }),
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
    instructions: {
      entry: {
        put: async (args: { sessionID: string; key: string; value: string }) => {
          this.record('session.instructions.entry.put', args);
          return {};
        },
      },
    },
    form: {
      reply: async (args: {
        sessionID: string;
        formID: string;
        answer: Record<string, unknown>;
      }) => {
        this.record('session.form.reply', args);
        return {};
      },
      cancel: async (args: { sessionID: string; formID: string }) => {
        this.record('session.form.cancel', args);
        return {};
      },
    },
  };

  permission = {
    reply: async (args: {
      sessionID: string;
      requestID: string;
      decision: 'once' | 'reject';
      message?: string;
    }) => {
      this.record('permission.reply', args);
      return {};
    },
  };

  event = {
    subscribe: (args: { signal: AbortSignal }): AsyncIterable<OpenCodeEvent> => {
      const queue: OpenCodeEvent[] = [];
      let wake: (() => void) | undefined;
      const listener = (event: OpenCodeEvent) => {
        queue.push(event);
        wake?.();
      };
      this.listeners.add(listener);
      const listeners = this.listeners;
      return {
        async *[Symbol.asyncIterator]() {
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
            listeners.delete(listener);
          }
        },
      };
    },
  };
}
