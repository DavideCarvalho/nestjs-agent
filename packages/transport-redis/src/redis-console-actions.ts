import { randomUUID } from 'node:crypto';
import type { AgentApprovalPort } from '@dudousxd/nestjs-agent-core';

/**
 * The pub/sub half of Redis a federated console's actions travel over. Same shape as the matching
 * methods of {@link import('./redis-stream-client.js').RedisStreamClient}, so one adapter over your
 * driver serves both. `subscribe` needs a connection in subscriber mode (see that client's notes).
 */
export interface RedisConsolePubSub {
  /** Publish `message` on `channel` (PUBLISH). */
  publish(channel: string, message: string): Promise<void>;
  /** Subscribe to `channel`, invoking `onMessage` per message. Resolves to an unsubscribe function. */
  subscribe(channel: string, onMessage: (message: string) => void): Promise<() => Promise<void>>;
}

/**
 * What the app-side {@link RedisConsoleActionResponder} needs: pub/sub, plus `claim` so that one
 * replica of the app, and only one, executes each request (every subscribed replica receives it).
 */
export interface RedisConsoleResponderClient extends RedisConsolePubSub {
  /**
   * Set `key` only if it does not exist yet, expiring after `ttlSeconds`
   * (`SET key 1 NX EX ttlSeconds`). `true` when this call set it. With ioredis:
   * `(await redis.set(key, '1', 'EX', ttlSeconds, 'NX')) === 'OK'`.
   */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
}

/** Options shared by both ends. Both must use the same `keyPrefix`. */
export interface RedisConsoleActionsOptions {
  /**
   * Channel/key namespace of one app's console actions. Default `agent:console`. Give every app
   * that shares a Redis its own prefix (`orders:agent:console`), and use the same one on the hub's
   * {@link RedisConsoleApprovalClient} for that app.
   */
  keyPrefix?: string;
}

/** Options of the hub-side {@link RedisConsoleApprovalClient}. */
export interface RedisConsoleApprovalClientOptions extends RedisConsoleActionsOptions {
  /** How long to wait for the app's answer before failing with a 504. Default 15000 ms. */
  timeoutMs?: number;
}

/** One action request on the wire. */
type ConsoleActionRequest =
  | {
      v: 1;
      id: string;
      action: 'approve';
      toolCallId: string;
      opts: { executedByRef?: string; remember?: boolean; decidedVia?: string };
    }
  | {
      v: 1;
      id: string;
      action: 'reject';
      toolCallId: string;
      opts: { executedByRef?: string; reason?: string; decidedVia?: string };
    };

/** The app's answer to one request. */
type ConsoleActionReply =
  | { id: string; ok: true }
  | { id: string; ok: false; status: number; message: string };

const DEFAULT_PREFIX = 'agent:console';
const DEFAULT_TIMEOUT_MS = 15_000;
/** How long a claim on a request id outlives it: long enough for every replica to have seen it. */
const CLAIM_TTL_SECONDS = 300;

const requestsChannel = (prefix: string): string => `${prefix}:requests`;
const replyChannel = (prefix: string, id: string): string => `${prefix}:reply:${id}`;
const claimKey = (prefix: string, id: string): string => `${prefix}:claim:${id}`;

/**
 * A console action the app refused or could not run, or one that got no answer. `status` is the
 * HTTP status the app answered with (`404` unknown tool call, `409` run not active, …), `504` when
 * no answer arrived in time (no responder running for this prefix, or the app is down).
 */
export class ConsoleActionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ConsoleActionError';
  }
}

/** The HTTP status an error carries (Nest's `HttpException#getStatus`, or a `status` field), else 500. */
function statusOf(error: unknown): number {
  if (typeof error === 'object' && error !== null) {
    const withGetter = error as { getStatus?: unknown; status?: unknown };
    if (typeof withGetter.getStatus === 'function') {
      const status = (withGetter.getStatus as () => unknown)();
      if (typeof status === 'number') return status;
    }
    if (typeof withGetter.status === 'number') return withGetter.status;
  }
  return 500;
}

function isRequest(value: unknown): value is ConsoleActionRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    typeof v.id === 'string' &&
    v.id !== '' &&
    (v.action === 'approve' || v.action === 'reject') &&
    typeof v.toolCallId === 'string' &&
    typeof v.opts === 'object' &&
    v.opts !== null
  );
}

/**
 * The hub's side of a federated agent console: an {@link AgentApprovalPort} that does not decide
 * anything itself. Each approve/reject is published on the app's Redis and executed by the app's
 * own {@link RedisConsoleActionResponder}, through the app's own approval port: the run resumes, and
 * the model and tools run, on the app's process. Resolves once the app has executed the decision;
 * rejects with a {@link ConsoleActionError} carrying the app's status, or 504 without an answer.
 *
 * Pass it as a federated app's `approvals` in `AgentDashboardModule.forRoot({ federation })`.
 */
export class RedisConsoleApprovalClient implements AgentApprovalPort {
  private readonly prefix: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly client: RedisConsolePubSub,
    options: RedisConsoleApprovalClientOptions = {},
  ) {
    this.prefix = options.keyPrefix ?? DEFAULT_PREFIX;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  approve(
    toolCallId: string,
    opts: { executedByRef?: string; remember?: boolean; decidedVia?: string } = {},
  ): Promise<void> {
    return this.send({ v: 1, id: randomUUID(), action: 'approve', toolCallId, opts });
  }

  reject(
    toolCallId: string,
    opts: { executedByRef?: string; reason?: string; decidedVia?: string } = {},
  ): Promise<void> {
    return this.send({ v: 1, id: randomUUID(), action: 'reject', toolCallId, opts });
  }

  /** Publish `request` and wait for its reply. Subscribes first, so a fast answer is not missed. */
  private async send(request: ConsoleActionRequest): Promise<void> {
    let settle: (reply: ConsoleActionReply | undefined) => void = () => undefined;
    const answered = new Promise<ConsoleActionReply | undefined>((resolve) => {
      settle = resolve;
    });
    const unsubscribe = await this.client.subscribe(
      replyChannel(this.prefix, request.id),
      (message) => {
        try {
          const reply = JSON.parse(message) as ConsoleActionReply;
          if (reply?.id === request.id) settle(reply);
        } catch {
          /* not a reply */
        }
      },
    );
    const timer = setTimeout(() => settle(undefined), this.timeoutMs);
    try {
      await this.client.publish(requestsChannel(this.prefix), JSON.stringify(request));
      const reply = await answered;
      if (reply === undefined) {
        throw new ConsoleActionError(
          504,
          `No answer from the app on "${this.prefix}" within ${this.timeoutMs} ms. Is its RedisConsoleActionResponder running?`,
        );
      }
      if (!reply.ok) throw new ConsoleActionError(reply.status, reply.message);
    } finally {
      clearTimeout(timer);
      await unsubscribe().catch(() => undefined);
    }
  }
}

/**
 * The app's side of a federated agent console: listens on the app's Redis for the console actions
 * a hub sends ({@link RedisConsoleApprovalClient}) and executes each one through the app's own
 * {@link AgentApprovalPort} (`AGENT_APPROVAL_PORT`, bound by `AgentModule`), the same path the app's
 * own console uses. One replica executes each request (`claim`), and its result goes back to the hub.
 *
 * It runs outside any HTTP request, so with the agent's tenancy on it acts with no tenant: a
 * `required` tenant refuses the action, as the app's own background work would be.
 *
 * Register it as a provider; Nest calls {@link onModuleInit} / {@link onModuleDestroy}. Outside Nest,
 * call {@link start} and {@link stop}.
 */
export class RedisConsoleActionResponder {
  private readonly prefix: string;
  private unsubscribe: (() => Promise<void>) | undefined;
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly client: RedisConsoleResponderClient,
    private readonly approvals: AgentApprovalPort,
    options: RedisConsoleActionsOptions = {},
  ) {
    this.prefix = options.keyPrefix ?? DEFAULT_PREFIX;
  }

  /** Start answering requests. Idempotent. */
  async start(): Promise<void> {
    if (this.unsubscribe !== undefined) return;
    this.unsubscribe = await this.client.subscribe(requestsChannel(this.prefix), (message) => {
      const handled = this.handle(message).catch(() => undefined);
      this.inflight.add(handled);
      void handled.finally(() => this.inflight.delete(handled));
    });
  }

  /** Stop answering, letting the requests already started finish. */
  async stop(): Promise<void> {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    await unsubscribe?.();
    await Promise.all([...this.inflight]);
  }

  onModuleInit(): Promise<void> {
    return this.start();
  }

  onModuleDestroy(): Promise<void> {
    return this.stop();
  }

  private async handle(message: string): Promise<void> {
    let request: unknown;
    try {
      request = JSON.parse(message);
    } catch {
      return;
    }
    if (!isRequest(request)) return;
    if (!(await this.client.claim(claimKey(this.prefix, request.id), CLAIM_TTL_SECONDS))) return;
    let reply: ConsoleActionReply;
    try {
      if (request.action === 'approve') {
        await this.approvals.approve(request.toolCallId, request.opts);
      } else {
        await this.approvals.reject(request.toolCallId, request.opts);
      }
      reply = { id: request.id, ok: true };
    } catch (error) {
      reply = {
        id: request.id,
        ok: false,
        status: statusOf(error),
        message: error instanceof Error ? error.message : String(error),
      };
    }
    await this.client.publish(replyChannel(this.prefix, request.id), JSON.stringify(reply));
  }
}
