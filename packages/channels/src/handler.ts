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
  type ToolConfirmation,
} from '@dudousxd/nestjs-agent-core';
import { agUiFramesFromNdjson } from '@dudousxd/nestjs-agent-core/ag-ui';
import { HttpException } from '@nestjs/common';
import { ChannelMediaTooLargeError } from './http.js';
import { toChannelMarkdown } from './markdown.js';
import {
  type ChannelQuestionTexts,
  DEFAULT_CHANNEL_QUESTION_TEXTS,
  formatChannelQuestion,
  parseChannelAnswer,
} from './questions.js';
import { splitMessage } from './split.js';
import type {
  ChannelAdapter,
  ChannelRequest,
  InboundMedia,
  InboundMessage,
  OutboundMessage,
} from './types.js';

/**
 * What a channel turn needs from the agent — `AgentService` is one. The optional methods turn
 * features on: proposals (buttons, outcomes), questions (`answer`) and media (`stageAttachment`).
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

/** A proposal the turn left pending, as the channel puts it to the person. */
export interface ChannelProposal {
  id: string;
  toolName: string;
  confirmation?: ToolConfirmation;
}

/** Why a media message could not be attached. */
export type ChannelMediaRefusal = 'disabled' | 'type' | 'size' | 'failed';

/** Everything the channel says on its own (not the model). English defaults; override any. */
export interface ChannelTexts {
  /** The Confirm button's label. */
  approve: string;
  /** The Cancel button's label. */
  reject: string;
  /** What a proposal says above its buttons — default: its confirmation's bold title and detail. */
  proposal(proposal: ChannelProposal): string;
  /**
   * How to answer a proposal by text, when there are no buttons. `approve`/`reject` are the reply
   * commands, built from the configured `actionProposalText.vocabulary` — `#ID` included when more
   * than one proposal is waiting.
   */
  instruction(commands: { approve: string; reject: string }): string;
  /** An approval in blocking mode, which a text channel cannot settle. */
  blockingApproval: string;
  /** The turn failed. */
  failed: string;
  /** An approved action ran, and presented nothing the channel could show. */
  actionSucceeded: string;
  /** An approved action's execution failed. */
  actionFailed: string;
  /** A file that could not be attached — no attachment store, a type or size it refuses, a failed download. */
  mediaRefused(
    reason: ChannelMediaRefusal,
    media: InboundMedia,
    limits: AttachmentLimits | null,
  ): string;
  /** How questions (the `ask` tool, intakes) are worded. */
  questions: ChannelQuestionTexts;
  /** Answer a sender `actor()` maps to nobody. Omitted → say nothing. */
  unknownSender?: string;
}

/** `20 MB`, `512 KB`. */
const readableSize = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${Math.round(bytes / (1024 * 1024))} MB`
    : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;

export const DEFAULT_CHANNEL_TEXTS: ChannelTexts = {
  approve: 'Confirm',
  reject: 'Cancel',
  proposal: ({ confirmation, toolName }) =>
    confirmation
      ? `*${confirmation.title}*${confirmation.detail ? `\n${confirmation.detail}` : ''}`
      : `*Run ${toolName}?*`,
  instruction: ({ approve, reject }) => `Reply *${approve}* to confirm or *${reject}* to cancel.`,
  blockingApproval: 'This action needs an approval that can only be given in the app.',
  failed: 'Sorry, something went wrong. Please try again.',
  actionSucceeded: 'Done.',
  actionFailed: 'The action could not be completed.',
  mediaRefused: (reason, media, limits) =>
    reason === 'disabled'
      ? 'I can only read text messages here.'
      : reason === 'size'
        ? `That file is too large${limits ? ` (the limit is ${readableSize(limits.maxBytes)})` : ''}.`
        : reason === 'failed'
          ? 'I could not download that file. Please send it again.'
          : media.kind === 'audio'
            ? 'I cannot listen to audio messages. Please type your message.'
            : `I cannot read this kind of file${media.contentType ? ` (${media.contentType})` : ''}.`,
  questions: DEFAULT_CHANNEL_QUESTION_TEXTS,
};

/** `texts` as a channel takes it: any part, `questions` too. */
export type ChannelTextsOverrides = Partial<Omit<ChannelTexts, 'questions'>> & {
  questions?: Partial<ChannelQuestionTexts>;
};

/** One channel: its adapter, and how its messages map onto accounts and threads. */
export interface ChannelOptions {
  adapter: ChannelAdapter;
  /**
   * The account the sender is — from `message.from` (a phone number, a Telegram id). `null` → the
   * message is not answered (or answered with `texts.unknownSender`). This IS the authentication of
   * every message, so map only senders the channel itself vouches for.
   */
  actor(message: InboundMessage): Actor | null | Promise<Actor | null>;
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
  /**
   * The turn's page context. Default `{ kind: adapter.name }`. The handler adds `channel: { name,
   * conversation }` to it — what a proposal's outcome is routed back by.
   */
  pageContext?: PageContext | ((message: InboundMessage) => PageContext);
  /** The agent that answers. Default: the thread's, else the configured default. */
  agentName?: string;
  /** How long a message id is remembered. Default 24 h. */
  dedupeTtlMs?: number;
  /** Stop waiting for a turn after this long (and cancel it). Default 5 minutes. */
  timeoutMs?: number;
  /**
   * After a proposal is approved, wait this long for it to execute and relay its outcome. `0` → do
   * not wait (the decision reply is all the person gets until the worker's settled hook relays it).
   * Default 60 s.
   */
  outcomeTimeoutMs?: number;
  /** How long a question waits for its answer before the agent proceeds without it. Default 30 min. */
  questionTimeoutMs?: number;
  texts?: ChannelTextsOverrides;
  /** A message whose handling failed. Default: logged. */
  onError?(error: unknown, message: InboundMessage): void;
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
}

/** A question set waiting for the person's answer, one question at a time. */
interface PendingQuestions {
  threadId: string | null;
  toolCallId: string;
  preamble?: string;
  questions: ElicitationQuestion[];
  index: number;
  answers: Record<string, string[]>;
}

/** The part of a proposal its outcome is read from — a stored proposal or its public view. */
type SettledProposal = Pick<ActionProposal | ActionProposalView, 'id' | 'decision' | 'outcome'> & {
  execution: { status: string } | null;
};

const BUTTON_ID = /^agora:(approve|reject):([^\s]+)$/;
/** The tail of a proposal id a button carries — Telegram's `callback_data` holds 64 bytes. */
const BUTTON_REF_LENGTH = 32;
const OUTCOME_POLL_MS = 500;
/** How long "this outcome was relayed" is remembered. */
const OUTCOME_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const buttonRef = (proposalId: string) => proposalId.slice(-BUTTON_REF_LENGTH);

/** The button ids for a proposal: what the handler maps back to its decision. */
export function proposalButtonIds(proposalId: string): { approve: string; reject: string } {
  const ref = buttonRef(proposalId);
  return { approve: `agora:approve:${ref}`, reject: `agora:reject:${ref}` };
}

export const mergeChannelTexts = (overrides: ChannelTextsOverrides = {}): ChannelTexts => ({
  ...DEFAULT_CHANNEL_TEXTS,
  ...overrides,
  questions: { ...DEFAULT_CHANNEL_QUESTION_TEXTS, ...overrides.questions },
});

/** What an executed proposal tells the person; `null` when it did not execute. */
function outcomeText(proposal: SettledProposal, texts: ChannelTexts): string | null {
  const status = proposal.execution?.status;
  if (status === 'failed') return texts.actionFailed;
  if (status !== 'succeeded') return null;
  // What its presentation said (`present` / `emitUi` text), else a plain confirmation.
  return proposal.outcome?.text?.trim() || texts.actionSucceeded;
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

/**
 * One channel's webhook, framework-free: {@link handle} takes a {@link ChannelRequest} and answers
 * a {@link ChannelHttpResponse}. Each request is verified (`401` when it is not the provider's),
 * parsed, deduplicated by the provider's message id, and acknowledged with `200` at once; the turn
 * runs after the response, so a slow model never makes the provider retry. Then:
 *
 * - media are downloaded and attached (held to the attachment limits), or refused with a text;
 * - the message is sent with text-only capabilities (components arrive as their `fallbackText`);
 *   a text decision ("yes", "confirm #ID") is answered with its reply instead of starting a turn;
 * - a press on a proposal's button decides that proposal (`via` = the adapter's name);
 * - a question the turn asks is sent as text, one at a time, and the next messages answer it;
 * - the reply is converted to the channel's markdown, split at its length limit, and sent;
 * - a proposal the turn left pending is sent with Confirm/Cancel buttons — or, on a channel without
 *   them, with a text instruction in the configured `actionProposalText` vocabulary;
 * - an approved proposal's outcome is relayed once it executed (see `outcomeTimeoutMs`, and
 *   {@link relayOutcome} for one that runs later).
 *
 * Wants `actionApprovalMode: 'independent'`: a blocking approval holds the turn open until someone
 * decides it in the app, so the channel sends what it has and `texts.blockingApproval`.
 */
export class ChannelHandler {
  readonly adapter: ChannelAdapter;
  readonly texts: ChannelTexts;
  private readonly dedupeTtlMs: number;
  private readonly timeoutMs: number;
  private readonly outcomeTimeoutMs: number;
  private readonly questionTimeoutMs: number;
  private readonly buttons: boolean;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly options: ChannelOptions,
    private readonly service: ChannelTurnService,
    private readonly store: ChannelStore,
    private readonly logError: (error: unknown, message: InboundMessage) => void = () => {},
  ) {
    this.adapter = options.adapter;
    this.texts = mergeChannelTexts(options.texts);
    this.dedupeTtlMs = options.dedupeTtlMs ?? 24 * 60 * 60 * 1000;
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    this.outcomeTimeoutMs = options.outcomeTimeoutMs ?? 60_000;
    this.questionTimeoutMs = options.questionTimeoutMs ?? 30 * 60 * 1000;
    this.buttons = (this.adapter.capabilities.buttons ?? 0) >= 2;
  }

  /** The webhook: answer at once, run the turns in the background. */
  async handle(request: ChannelRequest): Promise<ChannelHttpResponse> {
    const challenge = this.adapter.challenge?.(request) ?? null;
    if (challenge !== null) {
      return {
        status: challenge.status,
        body: challenge.body,
        contentType: challenge.contentType ?? 'text/plain',
      };
    }
    if (request.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };
    if (!(await this.adapter.verify(request)))
      return { status: 401, body: { error: 'unauthorized' } };
    const parsed = this.adapter.parse(request.body);
    const messages = parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed];
    const fresh: InboundMessage[] = [];
    // Claimed before the 200: a store that is down answers 500, and the provider retries.
    for (const message of messages) {
      if (await this.store.claim(`${this.adapter.name}:${message.id}`, this.dedupeTtlMs))
        fresh.push(message);
    }
    for (const message of fresh) {
      this.track(
        this.handleMessage(message).catch((error: unknown) => {
          if (this.options.onError) this.options.onError(error, message);
          else this.logError(error, message);
        }),
      );
    }
    return { status: 200, body: { ok: true } };
  }

  /** Resolves once every turn this handler started has been answered — for tests and shutdown. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  /**
   * Send an executed proposal's outcome to `conversation` unless it was sent already (by this or
   * another replica — the handler's own wait and the worker's settled hook share one claim).
   * `false` when it was not sent: not executed, or already relayed.
   */
  async relayOutcome(proposal: SettledProposal, conversation: string): Promise<boolean> {
    const text = outcomeText(proposal, this.texts);
    if (text === null) return false;
    if (!(await this.store.claim(`${this.adapter.name}:outcome:${proposal.id}`, OUTCOME_TTL_MS)))
      return false;
    await this.deliver(conversation, text);
    return true;
  }

  private track(work: Promise<void>) {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  /** Send `text` converted to the channel's markdown, split at its length limit. */
  private async deliver(conversation: string, text: string) {
    const { markdown, maxLength } = this.adapter.capabilities;
    for (const piece of splitMessage(toChannelMarkdown(text, markdown), maxLength))
      await this.adapter.send(conversation, { text: piece });
  }

  private questionKey(conversation: string) {
    return `${this.adapter.name}:question:${conversation}`;
  }

  private commandsFor(proposalId: string, withId: boolean): { approve: string; reject: string } {
    const vocabulary =
      this.service.actionProposalVocabulary?.() ?? DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY;
    const suffix = withId ? ` #${proposalId}` : '';
    return {
      approve: `${vocabulary.approve[0] ?? 'yes'}${suffix}`,
      reject: `${vocabulary.reject[0] ?? 'no'}${suffix}`,
    };
  }

  private async sendProposal(conversation: string, proposal: ChannelProposal, withId: boolean) {
    const { capabilities } = this.adapter;
    const summary = this.texts.proposal(proposal);
    const instruction = this.texts.instruction(this.commandsFor(proposal.id, withId));
    const asText = toChannelMarkdown(`${summary}\n\n${instruction}`, capabilities.markdown);
    if (!this.buttons) {
      for (const piece of splitMessage(asText, capabilities.maxLength))
        await this.adapter.send(conversation, { text: piece });
      return;
    }
    const ids = proposalButtonIds(proposal.id);
    const message: OutboundMessage = {
      text: toChannelMarkdown(summary, capabilities.markdown).slice(0, capabilities.maxLength),
      buttons: [
        { id: ids.approve, label: this.texts.approve },
        { id: ids.reject, label: this.texts.reject },
      ],
      fallbackText: asText.slice(0, capabilities.maxLength),
    };
    await this.adapter.send(conversation, message);
  }

  /** Wait for an approved proposal to run, then relay what it said (or that it failed). */
  private async awaitOutcome(
    actor: Actor,
    threadId: string,
    proposalId: string,
    conversation: string,
  ) {
    const list = this.service.listActionProposals?.bind(this.service);
    if (this.outcomeTimeoutMs <= 0 || !list) return;
    const deadline = Date.now() + this.outcomeTimeoutMs;
    while (Date.now() < deadline) {
      const current = (await list(actor, threadId)).find((proposal) => proposal.id === proposalId);
      if (current?.decision !== 'approved') return;
      if (outcomeText(current, this.texts) !== null) {
        await this.relayOutcome(current, conversation);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, OUTCOME_POLL_MS));
    }
  }

  /** A press on one of our proposal buttons: decide it. `false` → not one of ours. */
  private async pressButton(
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
      await this.deliver(
        message.conversation,
        service.actionProposalReply({ status: 'not_found' }, decision),
      );
      return true;
    }
    // The same policy-checked decision the web's approve/reject routes make, with the channel as
    // the surface it came through.
    const decided = await service.decideActionProposal(actor, threadId, proposal.id, {
      decision,
      via: this.adapter.name,
    });
    await this.deliver(message.conversation, decided.text);
    if (decided.proposalDecision.status === 'applied' && decision === 'approved')
      await this.awaitOutcome(actor, threadId, proposal.id, message.conversation);
    return true;
  }

  private askNext(conversation: string, pending: PendingQuestions) {
    const question = pending.questions[pending.index];
    if (!question) return Promise.resolve();
    return this.deliver(
      conversation,
      formatChannelQuestion(
        question,
        {
          index: pending.index,
          total: pending.questions.length,
          ...(pending.preamble !== undefined ? { preamble: pending.preamble } : {}),
        },
        this.texts.questions,
      ),
    );
  }

  /** The person's message answers the question in front of them; the last one resumes the run. */
  private async answerQuestion(actor: Actor, message: InboundMessage, pending: PendingQuestions) {
    const question = pending.questions[pending.index];
    if (!question || !this.service.answer) return;
    const { questions: words } = this.texts;
    const parsed = parseChannelAnswer(question, message.text, words.skipWord);
    if (parsed.status === 'invalid') {
      await this.deliver(message.conversation, words.invalid(parsed.problem));
      await this.askNext(message.conversation, pending);
      return;
    }
    const next: PendingQuestions = {
      ...pending,
      index: pending.index + 1,
      answers:
        parsed.status === 'answer'
          ? { ...pending.answers, [question.id]: parsed.values }
          : pending.answers,
    };
    const key = this.questionKey(message.conversation);
    if (next.index < next.questions.length) {
      await this.store.set(key, JSON.stringify(next), this.questionTimeoutMs);
      await this.askNext(message.conversation, next);
      return;
    }
    await this.store.delete(key);
    // The turn that asked is still being read: what the agent says next reaches the person there.
    await this.service.answer(actor, next.toolCallId, next.answers, { via: this.adapter.name });
  }

  /** Download a message's files and stage them for the turn; refuse what cannot be attached. */
  private async attachMedia(actor: Actor, message: InboundMessage): Promise<AttachmentRef[]> {
    const { service, adapter } = this;
    const refs: AttachmentRef[] = [];
    const declaredLimits = service.attachmentLimits?.() ?? null;
    const limits = declaredLimits?.enabled === true ? declaredLimits : null;
    for (const media of message.media ?? []) {
      const refuse = (reason: ChannelMediaRefusal) =>
        this.deliver(message.conversation, this.texts.mediaRefused(reason, media, limits));
      if (limits === null || !adapter.download || !service.stageAttachment) {
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
        const file = await adapter.download(media, { maxBytes: limits.maxBytes });
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
          if (status === null) this.options.onError?.(error, message);
        }
      }
    }
    return refs;
  }

  /** Read a run's frames until it ends (or parks on something a text channel cannot settle). */
  private async readTurn(
    actor: Actor,
    runId: string,
    threadId: string | null,
    conversation: string,
  ) {
    const { service } = this;
    const parts: string[] = [];
    const proposals = new Map<string, ChannelProposal>();
    const toolNames = new Map<string, string>();
    let failed = false;
    let blocked = false;
    let deadlineAt = Date.now() + this.timeoutMs;
    /** The question set this reader is waiting on, while it waits. */
    let asking: string | null = null;
    const flush = async () => {
      const text = parts.join('').trim();
      parts.length = 0;
      if (text !== '') await this.deliver(conversation, text);
    };
    const skip = (toolCallId: string) =>
      service.skip(actor, toolCallId, { via: this.adapter.name }).catch(() => {});
    const stream = agUiFramesFromNdjson(service.subscribe(runId))[Symbol.asyncIterator]();
    let reading: Promise<IteratorResult<AgentStreamEvent | { kind: string }>> | undefined;
    try {
      for (;;) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), Math.max(0, deadlineAt - Date.now()));
        });
        // A read that lost a race to the timer is still the next frame: keep it, never ask twice.
        reading ??= stream.next();
        const next = await Promise.race([reading, timeout]).finally(() => clearTimeout(timer));
        if (next !== 'timeout') reading = undefined;
        if (next === 'timeout') {
          if (asking !== null) {
            // Nobody answered: the agent goes on on its own assumptions.
            const toolCallId = asking;
            asking = null;
            await this.store.delete(this.questionKey(conversation));
            await skip(toolCallId);
            deadlineAt = Date.now() + this.timeoutMs;
            continue;
          }
          failed = parts.length === 0;
          await service.cancel(actor, runId).catch(() => {});
          break;
        }
        if (next.done) break;
        const frame = next.value as AgentStreamEvent | { kind: 'error' };
        if (asking !== null) {
          // The run moved on: the questions were answered (or skipped elsewhere).
          asking = null;
          deadlineAt = Date.now() + this.timeoutMs;
        }
        switch (frame.kind) {
          case 'text':
            parts.push(frame.text);
            break;
          case 'ui':
            // Only a component the turn negotiated as drawable comes as a frame — never with
            // text-only capabilities; its text is all a channel can show.
            if (frame.fallbackText) parts.push(`\n\n${frame.fallbackText}\n\n`);
            break;
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
            if (!service.answer || questions.length === 0) {
              await skip(frame.id);
              break;
            }
            await flush();
            const pending: PendingQuestions = {
              threadId,
              toolCallId: frame.id,
              ...(frame.request.preamble !== undefined ? { preamble: frame.request.preamble } : {}),
              questions,
              index: 0,
              answers: {},
            };
            await this.store.set(
              this.questionKey(conversation),
              JSON.stringify(pending),
              this.questionTimeoutMs,
            );
            await this.askNext(conversation, pending);
            asking = frame.id;
            deadlineAt = Date.now() + this.questionTimeoutMs;
            break;
          }
          case 'error':
            failed = true;
            break;
          default:
            break;
        }
        if (blocked) break;
      }
    } finally {
      void stream.return?.(undefined);
    }
    return { text: parts.join('').trim(), proposals: [...proposals.values()], failed, blocked };
  }

  private async handleMessage(message: InboundMessage) {
    const { service, adapter, options } = this;
    await adapter.acknowledge?.(message).catch(() => {});
    const actor = await options.actor(message);
    if (actor === null) {
      if (this.texts.unknownSender !== undefined)
        await this.deliver(message.conversation, this.texts.unknownSender);
      return;
    }
    const threadId = (await options.thread(actor, message)) ?? null;
    const ours = message.buttonId !== undefined && BUTTON_ID.test(message.buttonId);
    if (!ours) {
      const waiting = await this.store.get(this.questionKey(message.conversation));
      const pending = waiting === null ? null : (JSON.parse(waiting) as PendingQuestions);
      if (pending !== null && (pending.threadId === null || pending.threadId === threadId)) {
        await this.answerQuestion(actor, message, pending);
        return;
      }
    }
    if (await this.pressButton(actor, threadId, message)) return;
    const attachments = await this.attachMedia(actor, message);
    // A file nobody could attach, and no caption: there is nothing left to answer.
    if (message.text === '' && attachments.length === 0) return;
    const pageContext =
      typeof options.pageContext === 'function'
        ? options.pageContext(message)
        : (options.pageContext ?? { kind: adapter.name });
    const channel: ChannelAddress = { name: adapter.name, conversation: message.conversation };
    const sent = await service.send({
      actor,
      message: message.text,
      ...(threadId !== null ? { threadId } : {}),
      ...(options.agentName !== undefined ? { agentName: options.agentName } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      // Nothing is drawn: every component arrives as its text.
      uiCapabilities: { components: [] },
      pageContext: { ...pageContext, channel },
      hostContext: {
        channel: adapter.name,
        conversation: message.conversation,
        messageId: message.id,
      },
    });
    if (threadId === null) await options.onThreadCreated?.(sent.threadId, actor, message);
    if ('proposalDecision' in sent) {
      // A text decision ("yes", "confirm #ID"): its reply, not a turn.
      await this.deliver(message.conversation, sent.text);
      const decided = record(sent.proposalDecision);
      const proposal = record(decided?.proposal);
      if (
        decided?.status === 'applied' &&
        proposal?.decision === 'approved' &&
        typeof proposal.id === 'string'
      )
        await this.awaitOutcome(actor, sent.threadId, proposal.id, message.conversation);
      return;
    }
    // A queued message starts later under its own id: its answer is read the same way.
    const runId = sent.queued === true ? (sent.runId ?? sent.messageId) : sent.runId;
    const turn = await this.readTurn(actor, runId, sent.threadId, message.conversation);
    if (turn.text !== '') await this.deliver(message.conversation, turn.text);
    if (turn.failed) await this.deliver(message.conversation, this.texts.failed);
    if (turn.blocked) await this.deliver(message.conversation, this.texts.blockingApproval);
    for (const proposal of turn.proposals)
      await this.sendProposal(message.conversation, proposal, turn.proposals.length > 1);
  }
}
