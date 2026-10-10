import { createHash } from 'node:crypto';
import type { AgentService, AttachmentLimits } from '@dudousxd/nestjs-agent';
import {
  type ActionProposal,
  type ActionProposalView,
  type Actor,
  type AgentStreamEvent,
  type AttachmentRef,
  type ChannelStore,
  DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY,
  type ElicitationQuestion,
  type PageContext,
  parseTextActionProposalCommand,
} from '@dudousxd/nestjs-agent-core';
import { agUiFramesFromNdjson } from '@dudousxd/nestjs-agent-core/ag-ui';
import {
  type Catalog,
  type ChannelNativeButton,
  type ChannelRenderedMessage,
  type GenuiChannelBase,
  type GenuiChannels,
  type ResolvedGenuiChannel,
  channelButtonAction,
  renderChannelMessages,
  resolveGenuiChannel,
  uiActionText,
} from '@dudousxd/nestjs-agent-core/genui';
import { HttpException, Logger } from '@nestjs/common';
import {
  type ChannelExecutor,
  type ChannelJob,
  type ChannelRetryOptions,
  type ChannelStepRunner,
  type ChannelWorkflowEngine,
  durableExecutor,
  inlineExecutor,
  jobId,
  registerChannelWorkflows,
  withRetries,
} from './executor.js';
import { ChannelMediaTooLargeError } from './http.js';
import { toChannelMarkdown } from './markdown.js';
import { formatChannelQuestion, parseChannelAnswer } from './questions.js';
import { splitMessage } from './split.js';
import {
  type ChannelComponent,
  type ChannelMediaRefusal,
  type ChannelProposal,
  type ChannelTexts,
  type ChannelTextsOverrides,
  channelTextsFor,
  mergeChannelTexts,
} from './texts.js';
// Re-exported here, where they lived before `texts.ts`.
export {
  type ChannelComponent,
  type ChannelMediaRefusal,
  type ChannelProposal,
  type ChannelTexts,
  type ChannelTextsOverrides,
  channelTextsFor,
  DEFAULT_CHANNEL_TEXTS,
  mergeChannelTexts,
  ptBrChannelTexts,
} from './texts.js';
import type {
  ChannelAdapter,
  ChannelListRow,
  ChannelMediaFile,
  ChannelRequest,
  InboundMedia,
  InboundMessage,
  OutboundMedia,
  OutboundMessage,
} from './types.js';

/**
 * What a channel turn needs from the agent — `AgentService` is one. The optional methods turn
 * features on: proposals (buttons, outcomes), questions (`answer`) and media (`stageAttachment`).
 * `send` gets `{ textDecisions: false }`: the channel decides text decisions itself, only for the
 * cards it delivered to the conversation.
 */
export interface ChannelTurnService
  extends Pick<AgentService, 'send' | 'subscribe' | 'skip' | 'cancel' | 'actionProposalReply'>,
    Partial<
      Pick<
        AgentService,
        | 'decideActionProposal'
        | 'listActionProposals'
        | 'actionProposalVocabulary'
        | 'answer'
        | 'attachmentLimits'
        | 'stageAttachment'
      >
    > {}

/**
 * Something the channel sends on the app's behalf (a hook's answer): text in the model's markdown
 * (converted and split for the channel), text sent exactly as given (`raw` — a message the person
 * forwards as is), or a file with a caption.
 */
export type ChannelReply =
  | string
  | { text: string; raw?: boolean }
  | {
      media: OutboundMedia;
      /** In the model's markdown, converted. */
      caption?: string;
      /** What a channel without files sends instead. Default: the caption. */
      fallbackText?: string;
    };

/** What {@link ChannelOptions.beforeTurn} decides. */
export type ChannelGate =
  | 'continue'
  | 'stop'
  | undefined
  | { reply: ChannelReply }
  | { replies: ChannelReply[] };

/** What a hook is told about the message being handled. */
export interface ChannelHookContext {
  /** The adapter's name. */
  channel: string;
  conversation: string;
  message: InboundMessage;
}

/** A proposal whose outcome is relayed: a stored proposal, or its public view. */
export type ChannelSettledProposal = ActionProposal | ActionProposalView;

/** One message about to go out — what {@link ChannelOptions.canDeliver} checks. */
export interface ChannelDelivery {
  channel: string;
  conversation: string;
  /** What goes out, exactly as the adapter will get it. */
  outbound: OutboundMessage;
  /**
   * What it is: the turn's answer (`reply`), a proposal card, a relayed `outcome`, a `question`, a
   * hook's answer before the turn (`gate`), or the channel's own text (`notice`).
   */
  kind: 'reply' | 'card' | 'outcome' | 'question' | 'gate' | 'notice';
  /** Who the conversation was answered as, when known. */
  actor: Actor | null;
  /** The account reference the outbound belongs to: the actor's id, or a relayed proposal's `actorRef`. */
  actorRef: string | null;
  /** The message being answered, when there is one. */
  message: InboundMessage | null;
  /** The proposal whose outcome is relayed (`kind: 'outcome'`). */
  proposal: ChannelSettledProposal | null;
}

/** What a webhook request came to — {@link ChannelOptions.onWebhook}. */
export interface ChannelWebhookEvent {
  channel: string;
  /**
   * `accepted` → at least one new message taken; `duplicate` → only messages already taken;
   * `ignored` → a verified body with no message to answer; `unauthorized` → `verify` refused it;
   * `challenge` → a subscription check answered; `method_not_allowed`; `failed` → the messages
   * could not be taken (store or engine down): answered `500`, the provider retries.
   */
  status:
    | 'accepted'
    | 'duplicate'
    | 'ignored'
    | 'unauthorized'
    | 'challenge'
    | 'method_not_allowed'
    | 'failed';
  /** Why it was ignored (the adapter's reason — never message content), or what failed. */
  reason?: string;
  /** The provider's event name, when the body has one. */
  event?: string;
  /** New messages taken. */
  accepted: number;
  /** Messages already taken before (provider retries). */
  duplicates: number;
  /** The new messages, for counting — handled on their own, do not answer them here. */
  messages: readonly InboundMessage[];
}

/** A turn has started — {@link ChannelOptions.onTurnStarted}. */
export interface ChannelTurnStarted {
  runId: string;
  threadId: string;
  actor: Actor;
  message: InboundMessage;
  /** The message waits in the thread's queue (its run starts later under `runId`). */
  queued: boolean;
}

/** What {@link ChannelOptions.prepareMedia} makes of a downloaded file. */
export type ChannelPreparedMedia =
  | undefined
  /** Attach this file instead (converted, resized…). */
  | { file: ChannelMediaFile }
  /** Read the file as this text (a voice note's transcript): added to the message, not attached. */
  | { text: string }
  /** Refuse it with `texts.mediaRefused(reason)`. */
  | { refuse: ChannelMediaRefusal };

/** The message as it goes to the agent — what {@link ChannelOptions.transformInbound} edits. */
export interface ChannelInbound {
  /** The text (with prepared media's text appended). */
  text: string;
  attachments: AttachmentRef[];
}

type Awaitable<T> = T | Promise<T>;

/** One channel: its adapter, and how its messages map onto accounts and threads. */
export interface ChannelOptions {
  adapter: ChannelAdapter;
  /**
   * The account the sender is — from `message.from` (a phone number, a Telegram id). `null` → the
   * message is not answered by the agent ({@link unknownSender} / `texts.unknownSender`). This IS
   * the authentication of every message, so map only senders the channel itself vouches for.
   */
  actor(message: InboundMessage): Actor | null | Promise<Actor | null>;
  /**
   * A sender `actor()` mapped to nobody: what to answer (an onboarding step, a "link your number"
   * link) — `null`/`undefined` → nothing. Default: `texts.unknownSender`.
   */
  unknownSender?(
    message: InboundMessage,
    context: ChannelHookContext,
  ): Awaitable<ChannelReply | ChannelReply[] | null | undefined>;
  /**
   * Before anything else for a known sender — before its answers, button presses, text decisions
   * and turns: `'continue'` (or nothing) goes on; `'stop'` ends here; `{ reply }` / `{ replies }`
   * answers and ends here. For flows the app owns: terms to accept, an account to finish, a quota.
   */
  beforeTurn?(
    message: InboundMessage,
    actor: Actor,
    context: ChannelHookContext,
  ): Awaitable<ChannelGate>;
  /**
   * The thread this conversation continues; `null`/`undefined` → a new one, reported to
   * {@link onThreadCreated} so you can store it.
   */
  thread(
    actor: Actor,
    message: InboundMessage,
  ): string | null | undefined | Promise<string | null | undefined>;
  /** A new thread was created for the conversation — remember it for {@link thread}. */
  onThreadCreated?(threadId: string, actor: Actor, message: InboundMessage): void | Promise<void>;
  /** A turn started (or was queued) for a message — record where it came from, start a meter. */
  onTurnStarted?(turn: ChannelTurnStarted): void | Promise<void>;
  /**
   * Checked before EVERY message the channel sends — replies, cards, questions, relayed outcomes.
   * `false` → that message is dropped (e.g. the number was unlinked from the account mid-turn).
   */
  canDeliver?(delivery: ChannelDelivery): boolean | Promise<boolean>;
  /**
   * The turn's page context. Default `{ kind: adapter.name }`. The handler adds `channel: { name,
   * conversation }` to it — what a proposal's outcome is routed back by.
   */
  pageContext?: PageContext | ((message: InboundMessage) => PageContext);
  /** The agent that answers. Default: the thread's, else the configured default. */
  agentName?: string;
  /** How each phase of a message is retried when it fails. */
  retry?: ChannelRetryOptions;
  /** How long a message id (and what was delivered for it) is remembered. Default 24 h. */
  dedupeTtlMs?: number;
  /** Stop waiting for a turn after this long (and cancel it). Default 5 minutes. */
  timeoutMs?: number;
  /**
   * After a proposal is approved, wait this long for it to execute and relay its outcome. `0` → do
   * not wait (the worker's settled hook relays it once it runs). Default 60 s.
   */
  outcomeTimeoutMs?: number;
  /** How long a question waits for its answer before the agent proceeds without it. Default 30 min. */
  questionTimeoutMs?: number;
  /**
   * What the channel says on its own. Omitted parts come from {@link channelTextsFor}: Brazilian
   * Portuguese when the agent's `actionProposalText` is `ptBrActionProposalText`, else English. A
   * function picks them per message (the actor's locale) — `actor` is `null` before it is known and
   * for a relayed outcome (then `proposal` is set).
   */
  texts?:
    | ChannelTextsOverrides
    | ((context: {
        actor: Actor | null;
        message: InboundMessage | null;
        proposal?: ChannelSettledProposal;
      }) => Awaitable<ChannelTextsOverrides>);
  /**
   * Accept "always in this conversation" in a text decision. Default `true`; `false` → it is refused
   * with `texts.rememberRefused` (every action needs its own confirmation here).
   */
  allowRemember?: boolean;
  /**
   * What the turn may draw. Default `{ components: [] }`: every component arrives as its
   * `fallbackText`. Allow some with {@link renderComponent} to send them as files. With
   * `AgentGenuiModule.forRoot({ channels })` configured for this channel
   * ({@link ChannelAdapter.kind}, else `default`) the default is the channel's own: the components
   * it can draw, delivered natively.
   */
  uiCapabilities?: NonNullable<Parameters<AgentService['send']>[0]['uiCapabilities']>;
  /**
   * The genui setup this channel draws with — default: the app's (`AGENT_GENUI`, bound by
   * `AgentGenuiModule`). With `channels` configured for this channel, components arrive natively
   * (their `channels` conversion: text, reply buttons, lists, images; their text summary otherwise),
   * and a pressed button is the user's next turn, as a UI action. `false` → never (every component
   * as its text). A `ChannelHandler` built by hand draws natively only with `genui` passed.
   */
  genui?: ChannelGenui | false;
  /**
   * A component the turn drew: what to send for it — a file (a chart as an image), text, several —
   * or `null`/`undefined` for its `fallbackText`. Rendered components are sent when the turn ends (or
   * asks a question), before its text; a later one with the same id replaces it; a failed turn sends
   * none.
   */
  renderComponent?(
    component: ChannelComponent,
    context: { actor: Actor; conversation: string; runId: string; rendered: number },
  ): Awaitable<ChannelReply | ChannelReply[] | null | undefined>;
  /**
   * The attachment limits for one file — e.g. let audio through to {@link prepareMedia}, which
   * transcribes it. Default: the agent's (when attachments are enabled).
   */
  mediaLimits?(limits: AttachmentLimits | null, media: InboundMedia): AttachmentLimits | null;
  /**
   * A downloaded file, before it is attached: attach another (`{ file }`), read it as text (`{ text }`
   * — a voice note's transcript), refuse it, or (nothing) attach it as is.
   */
  prepareMedia?(
    file: ChannelMediaFile,
    media: InboundMedia,
    context: ChannelHookContext & { actor: Actor },
  ): Awaitable<ChannelPreparedMedia>;
  /**
   * The message as it goes to the agent, last: add a note about the attachments, a default question
   * for an image without a caption… Text decisions are read from the result.
   */
  transformInbound?(
    inbound: ChannelInbound,
    context: ChannelHookContext & { actor: Actor; threadId: string | null },
  ): Awaitable<ChannelInbound>;
  /**
   * What an executed proposal tells the person, in order — the outcome, then follow-ups (a message
   * to forward, sent `raw` and alone). Relayed once. `null`/`undefined` → the default (`text`: the
   * proposal's own outcome text, else `texts.actionSucceeded` / `texts.actionFailed`); `[]` → nothing.
   */
  formatOutcome?(
    proposal: ChannelSettledProposal,
    context: { text: string; texts: ChannelTexts },
  ): Awaitable<ChannelReply[] | null | undefined>;
  /** What every webhook request came to — for counters and logs, without parsing the body again. */
  onWebhook?(event: ChannelWebhookEvent): void | Promise<void>;
  /** A message whose handling failed (after its retries). Default: logged. */
  onError?(error: unknown, message: InboundMessage): void;
}

/** What a channel draws generative UI with — `AgentGenui` (`AGENT_GENUI`) is one. */
export interface ChannelGenui {
  catalog: Catalog;
  channels?: GenuiChannels;
  base?: GenuiChannelBase;
}

/** What the webhook route answers. */
export interface ChannelHttpResponse {
  status: number;
  /** A string is sent as is (`contentType`, default `text/plain`); anything else as JSON. */
  body: unknown;
  contentType?: string;
}

/** Where a turn's output goes back to — `pageContext.channel`, recorded with every proposal. */
export interface ChannelAddress {
  name: string;
  conversation: string;
  /** The adapter's {@link ChannelAdapter.kind}, when it has one — what `turnChannel` reads first. */
  kind?: string;
}

/** A question set waiting for the person's answer, one question at a time. */
interface PendingQuestions {
  threadId: string | null;
  /** The run whose stream the person reads. */
  streamRunId: string;
  toolCallId: string;
  preamble?: string;
  questions: ElicitationQuestion[];
  index: number;
  answers: Record<string, string[]>;
  /** The message the last answer came in — an answer applied once, however often its phase runs. */
  lastMessageId?: string;
}

const BUTTON_ID = /^agora:(approve|reject):([^\s]+)$/;
/** A component's button (or list entry): `ui:<ref>`, short enough for Telegram's 64-byte callback data. */
const UI_BUTTON_ID = /^ui:([A-Za-z0-9_-]{6,32})$/;
/** How long a component's buttons stay pressable, and how many per conversation are remembered by label. */
const UI_BUTTON_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_UI_BUTTONS = 40;
/** The tail of a proposal id a button carries — Telegram's `callback_data` holds 64 bytes. */
const BUTTON_REF_LENGTH = 32;
const OUTCOME_POLL_MS = 500;
/** How long "this outcome was relayed" is remembered. */
const OUTCOME_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const buttonRef = (proposalId: string) => proposalId.slice(-BUTTON_REF_LENGTH);
/** How long the proposal cards sent to a conversation are remembered, and how many. */
const CARDS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CARDS = 20;
const foldLabel = (label: string) => label.trim().toLowerCase();

/** The button ids for a proposal: what the handler maps back to its decision. */
export function proposalButtonIds(proposalId: string): { approve: string; reject: string } {
  const ref = buttonRef(proposalId);
  return { approve: `agora:approve:${ref}`, reject: `agora:reject:${ref}` };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The channel a proposal was made on — its recorded `pageContext.channel` — if any. */
export function channelOfProposal(proposal: ActionProposal): ChannelAddress | null {
  const address = record(proposal.executionContext?.pageContext?.channel);
  const name = address?.name;
  const conversation = address?.conversation;
  return typeof name === 'string' && typeof conversation === 'string'
    ? { name, conversation }
    : null;
}

/** `image/jpeg` → `jpeg`, for a file that arrives without a name. */
const extensionOf = (contentType: string) =>
  (contentType.split('/')[1] ?? 'bin').split(/[;+]/)[0] ?? 'bin';

/** The HTTP status of a refusal the agent answered with, if it is one. */
const statusOf = (error: unknown): number | null =>
  error instanceof HttpException ? error.getStatus() : null;

/** Where a natively drawn component sits in a turn's text, until it is sent. */
const NATIVE_MARK = '\u0000agora-native\u0000';

/** What a pressed component button stands for, kept until it is pressed (or expires). */
interface UiButton {
  conversation: string;
  button: ChannelNativeButton;
  componentId?: string;
  title?: string;
}

const replyList = <T>(value: T | T[] | null | undefined): T[] =>
  value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];

/** A sender the channels resolve their durable jobs to — the handler created last under a name. */
const registry = new Map<string, ChannelHandler>();
const runnerFor = (channel: string) => {
  const handler = registry.get(channel);
  return handler === undefined
    ? undefined
    : (job: ChannelJob, step: ChannelStepRunner) => handler.run(job, step);
};

type Outbox = {
  send(outbound: OutboundMessage, kind: ChannelDelivery['kind']): Promise<void>;
  text(value: string, kind: ChannelDelivery['kind']): Promise<void>;
  reply(value: ChannelReply, kind: ChannelDelivery['kind']): Promise<void>;
};

/**
 * One channel's webhook, framework-free: {@link handle} takes a {@link ChannelRequest} and answers
 * a {@link ChannelHttpResponse}. Each request is verified (`401` when it is not the provider's),
 * parsed, deduplicated by the provider's message id, taken (persisted, with a durable engine) and
 * acknowledged with `200`; the message is handled after the response — one at a time per
 * conversation, each phase retried — so a slow model never makes the provider retry. Then:
 *
 * - an unknown sender gets `unknownSender`; a known one goes through `beforeTurn`;
 * - an answer to a question the turn asked resumes it;
 * - a press on a proposal's button decides that proposal (`via` = the adapter's name);
 * - a text decision ("yes", "no #ID", a button label) decides a card delivered to THIS conversation
 *   — never a proposal made elsewhere (`texts.noPendingConfirmation`);
 * - media are downloaded (`prepareMedia`) and attached, or refused with a text;
 * - the message (`transformInbound`) starts a turn with the channel's capabilities;
 * - the reply is converted to the channel's markdown, split at its length limit, and sent — each
 *   message once, even when the work is retried or resumed after a crash;
 * - a proposal the turn left pending is sent with Confirm/Cancel buttons (or a text instruction);
 * - an approved proposal's outcome is relayed once it executed (see `outcomeTimeoutMs`, and
 *   {@link relayOutcome} for one that runs later).
 *
 * Wants `actionApprovalMode: 'independent'`: a blocking approval holds the turn open until someone
 * decides it in the app, so the channel sends what it has and `texts.blockingApproval`.
 */
export class ChannelHandler {
  readonly adapter: ChannelAdapter;
  /** The texts without a per-message function: the base in the agent's language, with `texts`. */
  readonly texts: ChannelTexts;
  private readonly dedupeTtlMs: number;
  private readonly timeoutMs: number;
  private readonly outcomeTimeoutMs: number;
  private readonly questionTimeoutMs: number;
  private readonly buttons: boolean;
  private readonly logger = new Logger('AgentChannels');
  private current: ChannelExecutor | undefined;
  private engine: ChannelWorkflowEngine | undefined;

  constructor(
    private readonly options: ChannelOptions,
    private readonly service: ChannelTurnService,
    private readonly store: ChannelStore,
    private readonly logError: (error: unknown, message: InboundMessage) => void = () => {},
    /** Run the messages as durable runs on this engine; omitted → in this process. */
    engine?: ChannelWorkflowEngine,
    /** The app's genui setup (`AGENT_GENUI`), when it has one — see {@link ChannelOptions.genui}. */
    private readonly appGenui?: ChannelGenui,
  ) {
    this.adapter = options.adapter;
    // The agent's reply words pick the language the channel speaks; `texts` overrides part by part.
    this.texts = mergeChannelTexts(
      typeof options.texts === 'function' ? {} : options.texts,
      channelTextsFor(service.actionProposalVocabulary?.() ?? null),
    );
    this.dedupeTtlMs = options.dedupeTtlMs ?? 24 * 60 * 60 * 1000;
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    this.outcomeTimeoutMs = options.outcomeTimeoutMs ?? 60_000;
    this.questionTimeoutMs = options.questionTimeoutMs ?? 30 * 60 * 1000;
    this.buttons = (this.adapter.capabilities.buttons ?? 0) >= 2;
    registry.set(this.adapter.name, this);
    if (engine !== undefined) this.useEngine(engine);
  }

  /**
   * Run this channel's messages as durable runs on `engine` (registering the channel workflows on
   * it): persisted before the `200`, one at a time per conversation, resumed after a crash. Call
   * before the first webhook — `AgentChannelsService` does on init.
   */
  useEngine(engine: ChannelWorkflowEngine): void {
    registerChannelWorkflows(engine, runnerFor);
    this.engine = engine;
    this.current = undefined;
  }

  /** Durable on the engine it was given, else in this process. */
  private executor(): ChannelExecutor {
    if (this.current) return this.current;
    this.current =
      this.engine !== undefined
        ? durableExecutor(this.engine)
        : inlineExecutor((job) => this.run(job, (_name, fn) => fn()));
    return this.current;
  }

  /** The webhook: take the messages, answer at once, handle them in the background. */
  async handle(request: ChannelRequest): Promise<ChannelHttpResponse> {
    const empty = { accepted: 0, duplicates: 0, messages: [] };
    const challenge = this.adapter.challenge?.(request) ?? null;
    if (challenge !== null) {
      await this.notify({ status: 'challenge', ...empty });
      return {
        status: challenge.status,
        body: challenge.body,
        contentType: challenge.contentType ?? 'text/plain',
      };
    }
    if (request.method !== 'POST') {
      await this.notify({ status: 'method_not_allowed', ...empty });
      return { status: 405, body: { error: 'method_not_allowed' } };
    }
    if (!(await this.adapter.verify(request))) {
      await this.notify({ status: 'unauthorized', ...empty });
      return { status: 401, body: { error: 'unauthorized' } };
    }
    const parsed = this.adapter.parse(request.body);
    const messages = parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed];
    if (messages.length === 0) {
      const ignored = this.logIgnored(request.body);
      await this.notify({ status: 'ignored', ...ignored, ...empty });
      return { status: 200, body: { ok: true } };
    }
    const fresh: InboundMessage[] = [];
    const name = this.adapter.name;
    try {
      // Taken before the 200: a store or an engine that is down answers 500, and the provider
      // retries.
      for (const message of messages) {
        const key = `${name}:${message.id}`;
        if (!(await this.store.claim(key, this.dedupeTtlMs))) continue;
        try {
          await this.executor().enqueue(
            { kind: 'message', channel: name, conversation: message.conversation, message },
            jobId(name, 'message', message.id),
          );
        } catch (error) {
          await Promise.resolve(this.store.delete(key)).catch(() => {});
          throw error;
        }
        fresh.push(message);
      }
    } catch (error) {
      await this.notify({
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        accepted: fresh.length,
        duplicates: 0,
        messages: fresh,
      });
      return { status: 500, body: { error: 'unavailable' } };
    }
    await this.notify({
      status: fresh.length > 0 ? 'accepted' : 'duplicate',
      accepted: fresh.length,
      duplicates: messages.length - fresh.length,
      messages: fresh,
    });
    return { status: 200, body: { ok: true } };
  }

  private async notify(event: Omit<ChannelWebhookEvent, 'channel'>): Promise<void> {
    try {
      await this.options.onWebhook?.({ channel: this.adapter.name, ...event });
    } catch {
      // Observation never changes the answer.
    }
  }

  /**
   * A verified webhook that carried no message to answer: logged (debug; warn when it looked like a
   * person's message that could not be read) with the event and the reason — never the content — so
   * a silently dropped message can be diagnosed.
   */
  private logIgnored(body: unknown): { reason: string; event?: string } {
    const ignored = this.adapter.ignored?.(body) ?? null;
    const event =
      ignored?.event ??
      (typeof body === 'object' && body !== null ? (body as { event?: unknown }).event : undefined);
    const reason = ignored?.reason ?? 'no message';
    const line = `Webhook on "${this.adapter.name}" ignored${typeof event === 'string' ? ` (event ${event})` : ''}: ${reason}`;
    if (ignored?.unexpected) this.logger.warn(line);
    else this.logger.debug(line);
    return { reason, ...(typeof event === 'string' ? { event } : {}) };
  }

  /**
   * Resolves once every message this handler took has been handled — for tests and shutdown. With
   * a durable engine: once their runs ended.
   */
  async drain(): Promise<void> {
    await this.executor().drain();
  }

  /**
   * Send an executed proposal's outcome to `conversation` unless it was sent already (by this or
   * another replica — the handler's own wait and the worker's settled hook share one claim), through
   * `formatOutcome`, `texts` and `canDeliver`. `false` when it was not sent: not executed, or already
   * relayed.
   */
  async relayOutcome(
    proposal: ChannelSettledProposal,
    conversation: string,
    who?: { actor: Actor | null; message: InboundMessage | null },
  ): Promise<boolean> {
    const status = proposal.execution?.status;
    if (status !== 'failed' && status !== 'succeeded') return false;
    const name = this.adapter.name;
    if (!(await this.store.claim(`${name}:outcome:${proposal.id}`, OUTCOME_TTL_MS))) return false;
    const texts = await this.textsFor({
      actor: who?.actor ?? null,
      message: who?.message ?? null,
      proposal,
    });
    // What its presentation said (`present` / `emitUi` text), else a plain confirmation.
    const text =
      status === 'failed'
        ? texts.actionFailed
        : proposal.outcome?.text?.trim() || texts.actionSucceeded;
    const replies = (await this.options.formatOutcome?.(proposal, { text, texts })) ?? [text];
    const out = this.outbox(`${name}:out:outcome:${proposal.id}`, conversation, {
      actor: who?.actor ?? null,
      actorRef: who?.actor?.id ?? proposal.actorRef ?? null,
      message: who?.message ?? null,
      proposal,
    });
    for (const reply of replies) await out.reply(reply, 'outcome');
    return true;
  }

  /** The texts for one context, over the defaults in the language of the service's vocabulary. */
  private async textsFor(context: {
    actor: Actor | null;
    message: InboundMessage | null;
    proposal?: ChannelSettledProposal;
  }): Promise<ChannelTexts> {
    if (typeof this.options.texts !== 'function') return this.texts;
    return mergeChannelTexts(
      await this.options.texts(context),
      channelTextsFor(this.service.actionProposalVocabulary?.() ?? null),
    );
  }

  private questionKey(conversation: string) {
    return `${this.adapter.name}:question:${conversation}`;
  }

  private cardsKey(conversation: string) {
    return `${this.adapter.name}:cards:${conversation}`;
  }

  private answeredKey(toolCallId: string) {
    return `${this.adapter.name}:answered:${toolCallId}`;
  }

  /**
   * Settle a question once — by its answer, by its timeout, or skipped: `true` when `owner` settles
   * it (now, or in an earlier run of the same phase), `false` when something else did first.
   */
  private async settleQuestion(toolCallId: string, owner: string): Promise<boolean> {
    const key = this.answeredKey(toolCallId);
    if (await this.store.claim(key, this.dedupeTtlMs)) {
      await this.store.set(key, owner, this.dedupeTtlMs);
      return true;
    }
    return (await this.store.get(key)) === owner;
  }

  /**
   * Sends to one conversation, each message at most once: every message takes a numbered slot
   * under `key` in the store before it goes out, so a phase that runs again (a retry, a crash
   * recovery) skips what already went. A failed send frees its slot, so the retry sends it.
   */
  private outbox(
    key: string,
    conversation: string,
    who: {
      actor: Actor | null;
      actorRef?: string | null;
      message: InboundMessage | null;
      proposal?: ChannelSettledProposal | null;
    },
  ): Outbox {
    const { adapter, store, options } = this;
    const { capabilities } = adapter;
    const ttl = this.dedupeTtlMs;
    let next = 0;
    const send = async (outbound: OutboundMessage, kind: ChannelDelivery['kind']) => {
      const slot = `${key}:${next++}`;
      if (!(await store.claim(slot, ttl))) return;
      try {
        if (
          options.canDeliver &&
          !(await options.canDeliver({
            channel: adapter.name,
            conversation,
            outbound,
            kind,
            actor: who.actor,
            actorRef: who.actorRef ?? who.actor?.id ?? null,
            message: who.message,
            proposal: who.proposal ?? null,
          }))
        )
          return;
        await adapter.send(conversation, outbound);
      } catch (error) {
        await Promise.resolve(store.delete(slot)).catch(() => {});
        throw error;
      }
    };
    /** Text in the model's markdown: converted, split. */
    const text = async (value: string, kind: ChannelDelivery['kind']) => {
      for (const piece of splitMessage(
        toChannelMarkdown(value, capabilities.markdown),
        capabilities.maxLength,
      ))
        await send({ text: piece }, kind);
    };
    /** A hook's reply. */
    const reply = async (value: ChannelReply, kind: ChannelDelivery['kind']) => {
      if (typeof value === 'string') return text(value, kind);
      if ('media' in value) {
        const caption = value.caption ?? '';
        if (capabilities.media === true) {
          const max = capabilities.maxCaptionLength ?? capabilities.maxLength;
          return send(
            {
              text: toChannelMarkdown(caption, capabilities.markdown).slice(0, max),
              media: value.media,
            },
            kind,
          );
        }
        const fallback = value.fallbackText ?? caption;
        if (fallback.trim() !== '') return text(fallback, kind);
        return;
      }
      if (value.raw === true) {
        for (const piece of splitMessage(value.text, capabilities.maxLength))
          await send({ text: piece }, kind);
        return;
      }
      return text(value.text, kind);
    };
    return { send, text, reply };
  }

  /** Remember a proposal card sent to `conversation` — the only proposals it can decide. */
  private async rememberCard(conversation: string, proposalId: string) {
    const key = this.cardsKey(conversation);
    const saved = await this.store.get(key);
    const ref = buttonRef(proposalId);
    const refs = saved === null ? [] : (JSON.parse(saved) as string[]);
    const next = [...refs.filter((known) => known !== ref), ref].slice(-MAX_CARDS);
    await this.store.set(key, JSON.stringify(next), CARDS_TTL_MS);
  }

  private async cardsOf(conversation: string): Promise<Set<string>> {
    const saved = await this.store.get(this.cardsKey(conversation));
    return new Set(saved === null ? [] : (JSON.parse(saved) as string[]));
  }

  /** What the channel is (`whatsapp`, `telegram`) — the turn's channel, whatever it is named. */
  private get kind(): string {
    return this.adapter.kind ?? this.adapter.name;
  }

  /** The genui setup, and this channel's options in it — `null` when it draws nothing natively. */
  private genuiFor(): { genui: ChannelGenui; channel: ResolvedGenuiChannel } | null {
    if (this.options.genui === false) return null;
    const genui = this.options.genui ?? this.appGenui;
    if (genui === undefined || genui.channels === undefined) return null;
    const channel = resolveGenuiChannel(genui.base ?? {}, genui.channels, this.kind);
    return channel.configured ? { genui, channel } : null;
  }

  private uiButtonKey(ref: string) {
    return `${this.adapter.name}:ui:${ref}`;
  }

  private uiButtonsKey(conversation: string) {
    return `${this.adapter.name}:uibuttons:${conversation}`;
  }

  /**
   * Remember a component's buttons — by id for the press, and by label for a provider that forwards
   * only the label (Whatsmiau). Each id is derived from the run, the component and its place, so a
   * phase that runs again names the same buttons.
   */
  private async rememberUiButtons(
    conversation: string,
    seed: string,
    message: ChannelRenderedMessage,
    entries: ChannelNativeButton[],
  ): Promise<string[]> {
    const { store } = this;
    const ids: string[] = [];
    const index = await store.get(this.uiButtonsKey(conversation));
    const known = index === null ? [] : (JSON.parse(index) as string[]);
    for (const [position, button] of entries.entries()) {
      const ref = createHash('sha256')
        .update(`${seed}:${position}`)
        .digest('base64url')
        .slice(0, 16);
      const saved: UiButton = {
        conversation,
        button,
        ...(message.componentId !== undefined ? { componentId: message.componentId } : {}),
        ...(message.title !== undefined ? { title: message.title } : {}),
      };
      await store.set(this.uiButtonKey(ref), JSON.stringify(saved), UI_BUTTON_TTL_MS);
      ids.push(`ui:${ref}`);
      known.push(ref);
    }
    await store.set(
      this.uiButtonsKey(conversation),
      JSON.stringify([...new Set(known)].slice(-MAX_UI_BUTTONS)),
      UI_BUTTON_TTL_MS,
    );
    return ids;
  }

  /** The component button a press (or, for a provider without ids, its label) names, if any. */
  private async pressedUiButton(message: InboundMessage): Promise<UiButton | null> {
    const { store } = this;
    const match = message.buttonId === undefined ? null : UI_BUTTON_ID.exec(message.buttonId);
    if (match !== null) {
      const saved = await store.get(this.uiButtonKey(match[1] ?? ''));
      const button = saved === null ? null : (JSON.parse(saved) as UiButton);
      return button !== null && button.conversation === message.conversation ? button : null;
    }
    if (message.buttonId !== undefined || message.buttonWithoutId !== true) return null;
    const index = await store.get(this.uiButtonsKey(message.conversation));
    const label = foldLabel(message.text);
    for (const ref of (index === null ? [] : (JSON.parse(index) as string[])).reverse()) {
      const saved = await store.get(this.uiButtonKey(ref));
      const button = saved === null ? null : (JSON.parse(saved) as UiButton);
      if (button !== null && foldLabel(button.button.label) === label) return button;
    }
    return null;
  }

  /**
   * One natively drawn message out: an image with its caption, text with reply buttons, a list (as
   * reply buttons when it fits and the channel has no lists, as numbered text when neither does), or
   * text — in the channel's markdown and limits.
   */
  private async sendNative(
    out: Outbox,
    conversation: string,
    seed: string,
    message: ChannelRenderedMessage,
  ): Promise<void> {
    const { capabilities } = this.adapter;
    const markdown = (text: string) => toChannelMarkdown(text, capabilities.markdown);
    const text = message.text ?? '';
    if (message.image !== undefined) {
      const { image } = message;
      await out.reply(
        {
          media: {
            kind: 'image',
            ...(image.url !== undefined ? { url: image.url } : {}),
            ...(image.data !== undefined ? { data: Buffer.from(image.data) } : {}),
            contentType: image.contentType ?? 'image/png',
          },
          caption: text,
          fallbackText: text,
        },
        'reply',
      );
    }
    const choices: Array<ChannelNativeButton & { description?: string }> =
      message.list?.items ?? message.buttons ?? [];
    if (choices.length === 0) {
      if (message.image === undefined && text.trim() !== '') await out.text(text, 'reply');
      return;
    }
    const body = message.image === undefined ? text : '';
    const numbered = [
      body,
      ...(message.list?.title !== undefined ? [`*${message.list.title}*`] : []),
      choices
        .map(
          (choice, index) =>
            `${index + 1}. ${choice.label}${choice.description ? ` — ${choice.description}` : ''}`,
        )
        .join('\n'),
    ]
      .filter((part) => part.trim() !== '')
      .join('\n\n');
    const maxButtons = capabilities.buttons ?? 0;
    const asButtons = message.list === undefined || (capabilities.lists ?? 0) === 0;
    if (asButtons && choices.length <= maxButtons) {
      const ids = await this.rememberUiButtons(conversation, seed, message, choices);
      await out.send(
        {
          text: markdown(body.trim() === '' ? (message.title ?? '…') : body).slice(
            0,
            capabilities.maxLength,
          ),
          buttons: choices.map((choice, index) => ({ id: ids[index] ?? '', label: choice.label })),
          fallbackText: markdown(numbered).slice(0, capabilities.maxLength),
        },
        'reply',
      );
      return;
    }
    const maxRows = capabilities.lists ?? 0;
    if (maxRows > 0) {
      const rows = choices.slice(0, maxRows);
      const ids = await this.rememberUiButtons(conversation, seed, message, rows);
      await out.send(
        {
          text: markdown(body.trim() === '' ? (message.title ?? '…') : body).slice(
            0,
            capabilities.maxLength,
          ),
          list: {
            button: message.list?.button ?? 'Options',
            ...(message.list?.title !== undefined ? { title: message.list.title } : {}),
            rows: rows.map(
              (row, index): ChannelListRow => ({
                id: ids[index] ?? '',
                title: row.label,
                ...(row.description !== undefined ? { description: row.description } : {}),
              }),
            ),
          },
          fallbackText: markdown(numbered).slice(0, capabilities.maxLength),
        },
        'reply',
      );
      return;
    }
    // Neither buttons nor lists: the choices as numbered text.
    await out.text(numbered, 'reply');
  }

  /**
   * A button press the provider forwarded without its id — only the label (Whatsmiau): the id of
   * the one card it can have come from — a card sent to this conversation whose proposal is still
   * pending. Several such cards → `undefined`: never guess; the label then goes on as a text
   * decision, which asks for the `#id`.
   */
  private async recoverButtonId(
    texts: ChannelTexts,
    actor: Actor,
    threadId: string | null,
    message: InboundMessage,
  ): Promise<string | undefined> {
    if (message.buttonId !== undefined || message.buttonWithoutId !== true) return undefined;
    if (threadId === null || !this.service.listActionProposals) return undefined;
    const label = foldLabel(message.text);
    const action =
      label === foldLabel(texts.approve)
        ? 'approve'
        : label === foldLabel(texts.reject)
          ? 'reject'
          : undefined;
    if (action === undefined) return undefined;
    const refs = await this.cardsOf(message.conversation);
    if (refs.size === 0) return undefined;
    const live = (await this.service.listActionProposals(actor, threadId)).filter(
      (proposal) => proposal.decision === 'pending' && refs.has(buttonRef(proposal.id)),
    );
    const only = live.length === 1 ? live[0] : undefined;
    return only === undefined ? undefined : `agora:${action}:${buttonRef(only.id)}`;
  }

  private commandsFor(proposalId: string | null): { approve: string; reject: string } {
    const vocabulary =
      this.service.actionProposalVocabulary?.() ?? DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY;
    const suffix = proposalId !== null ? ` #${proposalId}` : '';
    return {
      approve: `${vocabulary.approve[0] ?? 'yes'}${suffix}`,
      reject: `${vocabulary.reject[0] ?? 'no'}${suffix}`,
    };
  }

  private async sendProposal(
    texts: ChannelTexts,
    out: Outbox,
    conversation: string,
    proposal: ChannelProposal,
    withId: boolean,
  ) {
    const { capabilities } = this.adapter;
    const summary = texts.proposal(proposal);
    const footer = typeof texts.footer === 'function' ? texts.footer(proposal) : texts.footer;
    const instruction = texts.instruction(this.commandsFor(withId ? proposal.id : null));
    const asText = toChannelMarkdown(
      [summary, instruction, footer]
        .filter((part) => part !== undefined && part !== '')
        .join('\n\n'),
      capabilities.markdown,
    );
    // Remembered before it goes: a "yes" can only decide a card this conversation was sent.
    await this.rememberCard(conversation, proposal.id);
    if (!this.buttons) {
      for (const piece of splitMessage(asText, capabilities.maxLength))
        await out.send({ text: piece }, 'card');
      return;
    }
    const ids = proposalButtonIds(proposal.id);
    await out.send(
      {
        text: toChannelMarkdown(summary, capabilities.markdown).slice(0, capabilities.maxLength),
        buttons: [
          { id: ids.approve, label: texts.approve },
          { id: ids.reject, label: texts.reject },
        ],
        fallbackText: asText.slice(0, capabilities.maxLength),
        instruction: toChannelMarkdown(instruction, capabilities.markdown),
        ...(footer !== undefined && footer !== ''
          ? { footer: toChannelMarkdown(footer, capabilities.markdown) }
          : {}),
      },
      'card',
    );
  }

  /** Wait for an approved proposal to run, then relay what it said (or that it failed). */
  private async awaitOutcome(
    actor: Actor,
    threadId: string,
    proposalId: string,
    message: InboundMessage,
  ) {
    const list = this.service.listActionProposals?.bind(this.service);
    if (this.outcomeTimeoutMs <= 0 || !list) return;
    const deadline = Date.now() + this.outcomeTimeoutMs;
    while (Date.now() < deadline) {
      const current = (await list(actor, threadId)).find((proposal) => proposal.id === proposalId);
      if (current?.decision !== 'approved') return;
      const status = current.execution?.status;
      if (status === 'succeeded' || status === 'failed') {
        await this.relayOutcome(current, message.conversation, { actor, message });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, OUTCOME_POLL_MS));
    }
  }

  /** Decide one proposal by a press or a text, answer, and relay its outcome when it ran. */
  private async decide(
    out: Outbox,
    actor: Actor,
    threadId: string,
    proposalId: string,
    decision: 'approved' | 'rejected',
    remember: boolean,
    message: InboundMessage,
  ) {
    if (!this.service.decideActionProposal) return;
    // The same policy-checked decision the web's approve/reject routes make, with the channel as
    // the surface it came through.
    const decided = await this.service.decideActionProposal(actor, threadId, proposalId, {
      decision,
      ...(remember ? { remember: true } : {}),
      via: this.adapter.name,
    });
    await out.text(decided.text, 'notice');
    if (decided.proposalDecision.status === 'applied' && decision === 'approved')
      await this.awaitOutcome(actor, threadId, proposalId, message);
  }

  /** A press on one of our proposal buttons: decide it. `false` → not one of ours. */
  private async pressButton(
    out: Outbox,
    actor: Actor,
    threadId: string | null,
    message: InboundMessage,
  ): Promise<boolean> {
    const { service } = this;
    const match = message.buttonId === undefined ? null : BUTTON_ID.exec(message.buttonId);
    if (!match || !service.decideActionProposal || !service.listActionProposals) return false;
    const decision = match[1] === 'approve' ? 'approved' : 'rejected';
    const ref = match[2] ?? '';
    const proposal =
      threadId === null
        ? undefined
        : (await service.listActionProposals(actor, threadId)).find(
            (candidate) => buttonRef(candidate.id) === ref,
          );
    if (threadId === null || !proposal) {
      await out.text(service.actionProposalReply({ status: 'not_found' }, decision), 'notice');
      return true;
    }
    await this.decide(out, actor, threadId, proposal.id, decision, false, message);
    return true;
  }

  /**
   * A text decision ("yes", "no #ID", a button label the provider forwarded alone), scoped to the
   * cards this conversation was sent. `false` → not a decision: an ordinary message.
   */
  private async decideByText(
    texts: ChannelTexts,
    out: Outbox,
    actor: Actor,
    threadId: string | null,
    message: InboundMessage,
    text: string,
  ): Promise<boolean> {
    const { service } = this;
    if (threadId === null || !service.listActionProposals || !service.decideActionProposal)
      return false;
    const vocabulary =
      service.actionProposalVocabulary?.() ?? DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY;
    const command = parseTextActionProposalCommand(text, vocabulary);
    if (command.status !== 'command') return false;
    const proposals = await service.listActionProposals(actor, threadId);
    const cards = await this.cardsOf(message.conversation);
    const deliverable = proposals.filter(
      (proposal) => proposal.decision === 'pending' && cards.has(buttonRef(proposal.id)),
    );
    const refuseRemember = command.remember && this.options.allowRemember === false;
    const named = command.proposalId;
    if (named !== undefined) {
      const target = deliverable.find((proposal) => proposal.id === named);
      // An `#ID` naming no proposal of the thread is an ordinary message.
      if (target === undefined && !proposals.some((proposal) => proposal.id === named))
        return false;
      if (target === undefined) await out.text(texts.noPendingConfirmation, 'notice');
      else if (refuseRemember) await out.text(texts.rememberRefused, 'notice');
      else
        await this.decide(
          out,
          actor,
          threadId,
          target.id,
          command.decision,
          command.remember,
          message,
        );
      return true;
    }
    if (deliverable.length === 0) {
      // Nothing pending anywhere: "yes" is just a word in the conversation.
      if (!proposals.some((proposal) => proposal.decision === 'pending')) return false;
      await out.text(texts.noPendingConfirmation, 'notice');
      return true;
    }
    if (deliverable.length > 1) {
      await out.text(
        texts.ambiguousDecision(
          deliverable.map((proposal) => proposal.id),
          this.commandsFor(null),
        ),
        'notice',
      );
      return true;
    }
    const [only] = deliverable;
    if (only === undefined) return false;
    if (refuseRemember) await out.text(texts.rememberRefused, 'notice');
    else
      await this.decide(out, actor, threadId, only.id, command.decision, command.remember, message);
    return true;
  }

  private askNext(texts: ChannelTexts, out: Outbox, pending: PendingQuestions) {
    const question = pending.questions[pending.index];
    if (!question) return Promise.resolve();
    return out.text(
      formatChannelQuestion(
        question,
        {
          index: pending.index,
          total: pending.questions.length,
          ...(pending.preamble !== undefined ? { preamble: pending.preamble } : {}),
        },
        texts.questions,
      ),
      'question',
    );
  }

  /**
   * The person's message answers the question in front of them; the last one resumes the run.
   * Returns the run to read on, once all are answered (`'expired'`: it timed out meanwhile).
   */
  private async answerQuestion(
    texts: ChannelTexts,
    out: Outbox,
    actor: Actor,
    message: InboundMessage,
    pending: PendingQuestions,
  ): Promise<string | null | 'expired'> {
    if (!this.service.answer) return null;
    const key = this.questionKey(message.conversation);
    // This message's answer was applied already (its phase is running again): carry on from there.
    const applied = pending.lastMessageId === message.id;
    let next = pending;
    if (!applied) {
      const question = pending.questions[pending.index];
      if (!question) return null;
      const parsed = parseChannelAnswer(question, message.text, texts.questions.skipWord);
      if (parsed.status === 'invalid') {
        await out.text(texts.questions.invalid(parsed.problem), 'question');
        await this.askNext(texts, out, pending);
        return null;
      }
      next = {
        ...pending,
        index: pending.index + 1,
        answers:
          parsed.status === 'answer'
            ? { ...pending.answers, [question.id]: parsed.values }
            : pending.answers,
        lastMessageId: message.id,
      };
      await this.store.set(key, JSON.stringify(next), this.questionTimeoutMs);
    }
    if (next.index < next.questions.length) {
      await this.askNext(texts, out, next);
      return null;
    }
    if (!(await this.settleQuestion(next.toolCallId, `answer:${message.id}`))) {
      // It timed out while this answer was on its way: the run went on without it, and this is a
      // message like any other.
      await this.store.delete(key);
      return 'expired';
    }
    // The run that asked goes on: what it says next is read from its stream.
    try {
      await this.service.answer(actor, next.toolCallId, next.answers, { via: this.adapter.name });
    } catch (error) {
      // Taken by a run of this phase that died after answering: the run has it.
      if (!applied) throw error;
    }
    await this.store.delete(key);
    return next.streamRunId;
  }

  /** Download a message's files and stage them for the turn; refuse what cannot be attached. */
  private async attachMedia(
    texts: ChannelTexts,
    out: Outbox,
    actor: Actor,
    message: InboundMessage,
  ): Promise<{ refs: AttachmentRef[]; extra: string[] }> {
    const { service, adapter, options } = this;
    const refs: AttachmentRef[] = [];
    const extra: string[] = [];
    const declaredLimits = service.attachmentLimits?.() ?? null;
    const base = declaredLimits?.enabled === true ? declaredLimits : null;
    for (const media of message.media ?? []) {
      const limits = options.mediaLimits ? options.mediaLimits(base, media) : base;
      const refuse = (reason: ChannelMediaRefusal) =>
        out.text(texts.mediaRefused(reason, media, limits), 'notice');
      if (
        limits === null ||
        !adapter.download ||
        (!service.stageAttachment && !options.prepareMedia)
      ) {
        await refuse('disabled');
        continue;
      }
      const declared = media.contentType?.split(';')[0]?.trim().toLowerCase();
      if (declared !== undefined && !limits.allowedContentTypes.includes(declared)) {
        await refuse('type');
        continue;
      }
      if (media.sizeBytes !== undefined && media.sizeBytes > limits.maxBytes) {
        await refuse('size');
        continue;
      }
      try {
        let file = await adapter.download(media, { maxBytes: limits.maxBytes });
        const prepared = await options.prepareMedia?.(file, media, {
          channel: adapter.name,
          conversation: message.conversation,
          message,
          actor,
        });
        if (prepared && 'refuse' in prepared) {
          await refuse(prepared.refuse);
          continue;
        }
        if (prepared && 'text' in prepared) {
          if (prepared.text.trim() !== '') extra.push(prepared.text);
          continue;
        }
        if (prepared && 'file' in prepared) file = prepared.file;
        if (!service.stageAttachment) {
          await refuse('disabled');
          continue;
        }
        const attachment = await service.stageAttachment(actor, {
          data: file.data,
          contentType: file.contentType,
          filename: file.filename ?? `${media.kind}.${extensionOf(file.contentType)}`,
        });
        refs.push({ mediaId: attachment.mediaId });
      } catch (error) {
        const status = statusOf(error);
        if (error instanceof ChannelMediaTooLargeError || status === 413) await refuse('size');
        else if (status === 415) await refuse('type');
        else if (status === 501) await refuse('disabled');
        else {
          await refuse('failed');
          if (status === null) options.onError?.(error, message);
        }
      }
    }
    return { refs, extra };
  }

  /**
   * Read a run's frames until it ends (or parks on a question, or on something a text channel
   * cannot settle) and deliver them. Reads the stream from its start: what was delivered before (a
   * read before a question, a read a crash cut short) is skipped by its slot.
   */
  private async readTurn(
    actor: Actor,
    runId: string,
    threadId: string | null,
    conversation: string,
    message: InboundMessage | null,
  ) {
    const { service, options } = this;
    const name = this.adapter.name;
    const texts = await this.textsFor({ actor, message });
    const out = this.outbox(`${name}:out:${runId}`, conversation, { actor, message });
    const parts: string[] = [];
    const proposals = new Map<string, ChannelProposal>();
    const toolNames = new Map<string, string>();
    /** Components rendered as files, by id (a later one replaces), sent before the text. */
    const rendered = new Map<string, { component: ChannelComponent; replies: ChannelReply[] }>();
    /** Components drawn natively (genui channels), by id, sent where they came in the text. */
    const natives = new Map<string, ChannelRenderedMessage[]>();
    const native = this.genuiFor();
    const asText = new Set<string>();
    let wroteText = false;
    let failed = false;
    let blocked = false;
    let parked = false;
    const deadlineAt = Date.now() + this.timeoutMs;
    const flush = async (end: boolean) => {
      const batch = [...rendered.values()];
      rendered.clear();
      for (const { replies } of batch) for (const reply of replies) await out.reply(reply, 'reply');
      // Text and natively drawn components, in the order the turn produced them.
      const segments = parts.join('').split(NATIVE_MARK);
      parts.length = 0;
      for (const [index, segment] of segments.entries()) {
        if (index % 2 === 0) {
          if (segment.trim() !== '') await out.text(segment.trim(), 'reply');
          continue;
        }
        const messages = natives.get(segment) ?? [];
        for (const [position, message] of messages.entries())
          await this.sendNative(out, conversation, `${runId}:${segment}:${position}`, message);
      }
      natives.clear();
      if (end && !wroteText && batch.length > 0) {
        const after = texts.componentsOnly?.(batch.map(({ component }) => component));
        if (after !== undefined && after !== '') await out.text(after, 'reply');
      }
    };
    const skip = (toolCallId: string) =>
      service.skip(actor, toolCallId, { via: name }).catch(() => {});
    const stream = agUiFramesFromNdjson(service.subscribe(runId))[Symbol.asyncIterator]();
    try {
      for (;;) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), Math.max(0, deadlineAt - Date.now()));
        });
        const next = await Promise.race([stream.next(), timeout]).finally(() =>
          clearTimeout(timer),
        );
        if (next === 'timeout') {
          failed = parts.length === 0 && rendered.size === 0 && !wroteText;
          await service.cancel(actor, runId).catch(() => {});
          break;
        }
        if (next.done) break;
        const frame = next.value as AgentStreamEvent | { kind: 'error' };
        switch (frame.kind) {
          case 'text':
            wroteText ||= frame.text.trim() !== '';
            parts.push(frame.text);
            break;
          case 'ui': {
            // A preview of a layout the model is still writing: a channel gets the final
            // component (or its fallback text) and nothing before it.
            if (frame.partial === true) break;
            const component: ChannelComponent = {
              id: frame.id,
              name: frame.component,
              data: frame.props,
              version: frame.version ?? 1,
              ...(frame.fallbackText !== undefined ? { fallbackText: frame.fallbackText } : {}),
            };
            const replies = options.renderComponent
              ? replyList(
                  await options.renderComponent(component, {
                    actor,
                    conversation,
                    runId,
                    rendered: rendered.size,
                  }),
                )
              : [];
            if (replies.length > 0) {
              rendered.set(component.id, { component, replies });
              break;
            }
            rendered.delete(component.id);
            if (native !== null) {
              // A genui channel: the component as this channel draws it, where it came in the text.
              const drawn = await renderChannelMessages(
                native.genui.catalog,
                {
                  id: component.id,
                  name: component.name,
                  props: (component.data ?? {}) as Record<string, unknown>,
                },
                native.channel,
              );
              if (drawn.length === 0) break;
              wroteText = true;
              if (!natives.has(component.id))
                parts.push(`${NATIVE_MARK}${component.id}${NATIVE_MARK}`);
              natives.set(component.id, drawn);
              break;
            }
            if (component.fallbackText && !asText.has(component.id)) {
              // Only a component the turn negotiated as drawable comes as a frame; its text is all
              // a channel that does not render it can show.
              asText.add(component.id);
              wroteText = true;
              parts.push(`\n\n${component.fallbackText}\n\n`);
            }
            break;
          }
          case 'tool-input-start':
          case 'tool-input-available':
            toolNames.set(frame.id, frame.name);
            break;
          case 'approval-requested':
            if (frame.target?.kind === 'proposal') {
              proposals.set(frame.target.proposalId, {
                id: frame.target.proposalId,
                toolName: toolNames.get(frame.id) ?? 'action',
                ...(frame.confirmation ? { confirmation: frame.confirmation } : {}),
              });
              break;
            }
            // Blocking mode: the run waits for a decision this channel cannot make.
            blocked = true;
            break;
          case 'elicitation': {
            const questions = frame.request.questions;
            const asked: PendingQuestions = {
              threadId,
              streamRunId: runId,
              toolCallId: frame.id,
              ...(frame.request.preamble !== undefined ? { preamble: frame.request.preamble } : {}),
              questions,
              index: 0,
              answers: {},
            };
            if ((await this.store.get(this.answeredKey(frame.id))) !== null) {
              // Answered (or skipped) before, and the run went on past it. What was sent around it
              // then is sent (skipped, by its slots) the same way now, so what follows keeps its
              // slots.
              if (service.answer && questions.length > 0) {
                await flush(false);
                await this.askNext(texts, out, asked);
              }
              break;
            }
            if (!service.answer || questions.length === 0) {
              await this.settleQuestion(frame.id, 'skipped');
              await skip(frame.id);
              break;
            }
            await flush(false);
            const key = this.questionKey(conversation);
            const waiting = await this.store.get(key);
            const same =
              waiting !== null && (JSON.parse(waiting) as PendingQuestions).toolCallId === frame.id;
            if (!same) await this.store.set(key, JSON.stringify(asked), this.questionTimeoutMs);
            await this.askNext(texts, out, asked);
            // The answers come as the next messages; nobody answering in time skips it.
            const at = Date.now() + this.questionTimeoutMs;
            await this.executor().later(
              {
                kind: 'timeout',
                channel: name,
                conversation,
                at,
                toolCallId: frame.id,
                streamRunId: runId,
                threadId,
                actor,
              },
              jobId(name, 'timeout', runId, frame.id),
              at,
            );
            parked = true;
            break;
          }
          case 'error':
            failed = true;
            // A failed turn shows none of what it drew before failing.
            rendered.clear();
            natives.clear();
            break;
          default:
            break;
        }
        if (blocked || parked) break;
      }
    } finally {
      void stream.return?.(undefined);
    }
    if (parked) return;
    await flush(true);
    if (failed) await out.text(texts.failed, 'notice');
    if (blocked) await out.text(texts.blockingApproval, 'notice');
    const left = [...proposals.values()];
    for (const proposal of left)
      await this.sendProposal(texts, out, conversation, proposal, left.length > 1);
  }

  private hookContext(message: InboundMessage): ChannelHookContext {
    return { channel: this.adapter.name, conversation: message.conversation, message };
  }

  /** Before the turn: who is talking, and whether the app lets them through. */
  private async prepare(
    message: InboundMessage,
  ): Promise<{ stop: true } | { stop: false; actor: Actor; threadId: string | null }> {
    const { adapter, options } = this;
    await adapter.acknowledge?.(message).catch(() => {});
    const actor = await options.actor(message);
    if (actor === null) {
      const out = this.outbox(
        `${adapter.name}:out:msg:${message.id}:sender`,
        message.conversation,
        { actor: null, message },
      );
      const replies = options.unknownSender
        ? replyList(await options.unknownSender(message, this.hookContext(message)))
        : replyList((await this.textsFor({ actor: null, message })).unknownSender);
      for (const reply of replies) await out.reply(reply, 'gate');
      return { stop: true };
    }
    const gate = await options.beforeTurn?.(message, actor, this.hookContext(message));
    if (gate === 'stop') return { stop: true };
    if (gate !== undefined && gate !== 'continue') {
      const out = this.outbox(`${adapter.name}:out:msg:${message.id}:gate`, message.conversation, {
        actor,
        message,
      });
      for (const reply of 'replies' in gate ? gate.replies : [gate.reply])
        await out.reply(reply, 'gate');
      return { stop: true };
    }
    const threadId = (await options.thread(actor, message)) ?? null;
    return { stop: false, actor, threadId };
  }

  /**
   * The message itself: an answer, a press, a decision, or a turn. Returns the run to read, if any.
   * A turn is started once per message, however often this runs: its run id is kept under the
   * message id.
   */
  private async act(
    received: InboundMessage,
    actor: Actor,
    threadId: string | null,
  ): Promise<{ runId: string; threadId: string | null } | null> {
    const { service, adapter, options, store } = this;
    const name = adapter.name;
    const turnKey = `${name}:turn:${received.id}`;
    const started = await store.get(turnKey);
    if (started !== null && started !== '') {
      // This phase ran to its end before (a retry, a recovery): the same outcome.
      return JSON.parse(started) as { runId: string; threadId: string | null } | null;
    }
    /** What this message came to, kept so a phase that runs again does not do it twice. */
    const done = async (result: { runId: string; threadId: string | null } | null) => {
      await store.set(turnKey, JSON.stringify(result), this.dedupeTtlMs);
      return result;
    };
    const texts = await this.textsFor({ actor, message: received });
    const out = this.outbox(`${name}:out:msg:${received.id}`, received.conversation, {
      actor,
      message: received,
    });
    const recovered = await this.recoverButtonId(texts, actor, threadId, received);
    const message = recovered === undefined ? received : { ...received, buttonId: recovered };
    const ours = message.buttonId !== undefined && BUTTON_ID.test(message.buttonId);
    if (!ours) {
      const waiting = await store.get(this.questionKey(message.conversation));
      const pending = waiting === null ? null : (JSON.parse(waiting) as PendingQuestions);
      if (pending !== null && (pending.threadId === null || pending.threadId === threadId)) {
        const resume = await this.answerQuestion(texts, out, actor, message, pending);
        if (resume !== 'expired')
          return done(resume === null ? null : { runId: resume, threadId: pending.threadId });
      }
    }
    if (await this.pressButton(out, actor, threadId, message)) return done(null);
    // A component's button (or list entry): the user's next turn, as a UI action — the same thing a
    // sandbox's `agent.send` and an A2UI button become.
    const uiButton = await this.pressedUiButton(message);
    const media = uiButton === null ? await this.attachMedia(texts, out, actor, message) : null;
    let inbound: ChannelInbound = {
      text:
        uiButton !== null
          ? uiActionText(
              channelButtonAction(uiButton.button, {
                ...(uiButton.componentId !== undefined
                  ? { componentId: uiButton.componentId }
                  : {}),
                ...(uiButton.title !== undefined ? { title: uiButton.title } : {}),
              }),
            )
          : [message.text, ...(media?.extra ?? [])]
              .filter((part) => part.trim() !== '')
              .join('\n\n'),
      attachments: media?.refs ?? [],
    };
    if (options.transformInbound)
      inbound = await options.transformInbound(inbound, {
        ...this.hookContext(message),
        actor,
        threadId,
      });
    if (
      inbound.attachments.length === 0 &&
      (await this.decideByText(texts, out, actor, threadId, message, inbound.text))
    )
      return done(null);
    // A file nobody could attach, and no caption: there is nothing left to answer.
    if (inbound.text === '' && inbound.attachments.length === 0) return done(null);
    if (!(await store.claim(turnKey, this.dedupeTtlMs))) {
      // Taken by a run of this phase that died between starting the turn and recording it: never
      // start a second turn for one message.
      throw Object.assign(
        new Error(
          `channel ${name}: message ${message.id} may have started a turn already; not starting another`,
        ),
        { name: 'ChannelTurnUncertainError', status: 409 },
      );
    }
    const pageContext =
      typeof options.pageContext === 'function'
        ? options.pageContext(message)
        : (options.pageContext ?? { kind: name });
    const channel: ChannelAddress = {
      name,
      conversation: message.conversation,
      ...(adapter.kind !== undefined ? { kind: adapter.kind } : {}),
    };
    // A channel genui draws for: the turn may push whatever this channel can draw (the tools are
    // narrowed to it), and the components arrive whole, for the history and for native delivery.
    const drawsNatively = options.uiCapabilities === undefined && this.genuiFor() !== null;
    let sent: Awaited<ReturnType<ChannelTurnService['send']>>;
    try {
      sent = await service.send(
        {
          actor,
          message: inbound.text,
          ...(threadId !== null ? { threadId } : {}),
          ...(options.agentName !== undefined ? { agentName: options.agentName } : {}),
          ...(inbound.attachments.length > 0 ? { attachments: inbound.attachments } : {}),
          ...(drawsNatively
            ? {}
            : { uiCapabilities: options.uiCapabilities ?? { components: [] } }),
          pageContext: { ...pageContext, channel },
          hostContext: { channel: name, conversation: message.conversation, messageId: message.id },
        },
        // Decided above, only for this conversation's cards.
        { textDecisions: false },
      );
    } catch (error) {
      // Nothing started: a retry may start it.
      await Promise.resolve(store.delete(turnKey)).catch(() => {});
      throw error;
    }
    if (threadId === null) await options.onThreadCreated?.(sent.threadId, actor, message);
    if ('proposalDecision' in sent) {
      // A service that decides by text itself (one that ignores `textDecisions`).
      await done(null);
      await out.text(sent.text, 'notice');
      const decided = record(sent.proposalDecision);
      const proposal = record(decided?.proposal);
      if (
        decided?.status === 'applied' &&
        proposal?.decision === 'approved' &&
        typeof proposal.id === 'string'
      )
        await this.awaitOutcome(actor, sent.threadId, proposal.id, message);
      return null;
    }
    // A queued message starts later under its own id: its answer is read the same way.
    const runId = sent.queued === true ? (sent.runId ?? sent.messageId) : sent.runId;
    const turn = await done({ runId, threadId: sent.threadId });
    await options.onTurnStarted?.({
      runId,
      threadId: sent.threadId,
      actor,
      message,
      queued: sent.queued === true,
    });
    return turn;
  }

  private retry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetries(fn, this.options.retry);
  }

  private report(error: unknown, message: InboundMessage | null) {
    if (message === null) {
      this.logger.error(
        `A job on "${this.adapter.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (this.options.onError) this.options.onError(error, message);
    else this.logError(error, message);
  }

  /** One job, phase by phase — each phase a checkpoint under a durable engine. @internal */
  async run(job: ChannelJob, step: ChannelStepRunner): Promise<void> {
    const message = job.kind === 'message' ? job.message : null;
    const name = this.adapter.name;
    try {
      if (job.kind === 'timeout') {
        await step('timeout', () =>
          this.retry(async () => {
            // Answered in time: nothing to do.
            if (!(await this.settleQuestion(job.toolCallId, 'timeout'))) return false;
            // Nobody answered: the agent goes on on its own assumptions.
            const key = this.questionKey(job.conversation);
            const waiting = await this.store.get(key);
            const pending = waiting === null ? null : (JSON.parse(waiting) as PendingQuestions);
            if (pending?.toolCallId === job.toolCallId) await this.store.delete(key);
            await this.service.skip(job.actor, job.toolCallId, { via: name }).catch(() => {});
            await this.executor().enqueue(
              {
                kind: 'resume',
                channel: name,
                conversation: job.conversation,
                runId: job.streamRunId,
                threadId: job.threadId,
                actor: job.actor,
              },
              jobId(name, 'resume', job.streamRunId, job.toolCallId),
            );
            return true;
          }),
        );
        return;
      }
      if (job.kind === 'resume') {
        await step('read', () =>
          this.retry(async () => {
            await this.readTurn(job.actor, job.runId, job.threadId, job.conversation, null);
            return null;
          }),
        );
        return;
      }
      const received = job.message;
      const prepared = await step('prepare', () => this.retry(() => this.prepare(received)));
      if (prepared.stop) return;
      const turn = await step('act', () =>
        this.retry(() => this.act(received, prepared.actor, prepared.threadId)),
      );
      if (turn === null) return;
      await step('read', () =>
        this.retry(async () => {
          await this.readTurn(
            prepared.actor,
            turn.runId,
            turn.threadId,
            received.conversation,
            received,
          );
          return null;
        }),
      );
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name === 'WorkflowSuspended') throw error;
      this.report(error, message);
    }
  }
}
