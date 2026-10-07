import {
  AGENT_ACTOR_RESOLVER,
  AGENT_ATTACHMENT_STAGING,
  AGENT_OPTIONS,
  type Actor,
  type ActorResolver,
  type AttachmentRef,
  type AttachmentStagingStore,
  type PageContext,
} from '@dudousxd/nestjs-agent-core';
import {
  AG_UI_CUSTOM,
  type AgUiEvent,
  type AgUiStreamOptions,
  type InlineMedia,
  type ResumeDecision,
  actionProposalDecisionEvents,
  agUiEvents,
  agUiFramesFromNdjson,
  agUiSse,
  parseRunInput,
  planResume,
  readAnswersPayload,
  readApprovalPayload,
  readContext,
  readForwardedProps,
  readUserTurn,
} from '@dudousxd/nestjs-agent-core/ag-ui';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Optional,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AgentModuleOptions } from '../agent.options.js';
import { AgentService } from '../agent.service.js';
import { attachmentLimits } from '../attachment-limits.js';
import { answers as boundedAnswers, rejectReason } from '../controller/tool-call.controller.js';
import type { AgentProtocolAdapter } from '../protocol-adapter.js';

export interface AgUiAdapterOptions {
  /** Where the route mounts, under the agent's path. Default `'ag-ui'` → `POST <path>/ag-ui`. */
  path?: string;
  /**
   * How long a run that is waiting on a person AND still has other work announced may stay silent
   * before it is reported interrupted. Default 750 ms.
   */
  quietMs?: number;
}

/** The surface an AG-UI resume decision is recorded as having come through. */
const AG_UI_VIA = 'ag-ui';

function invalid(code: string, message: string): BadRequestException {
  return new BadRequestException({ statusCode: 400, code, message });
}

/** Input material the route could not use, as the events that say so. */
function warningEvents(warnings: readonly string[]): AgUiEvent[] {
  return warnings.map((message) => ({
    type: 'CUSTOM' as const,
    name: AG_UI_CUSTOM.warning,
    value: { message },
  }));
}

/**
 * Serves the agent over AG-UI 1.0. Not mounted directly — {@link agUiAdapter} mounts a subclass at
 * the configured path — but exported so a host can extend it under a route of its own.
 */
export class AgUiRunHandler {
  constructor(
    protected readonly agent: AgentService,
    protected readonly actorResolver: ActorResolver,
    protected readonly options: AgentModuleOptions,
    protected readonly staging: AttachmentStagingStore | undefined,
    protected readonly quietMs: number | undefined,
  ) {}

  async handle(req: Request, res: Response, body: unknown): Promise<void> {
    const input = parseRunInput(body);
    if (typeof input === 'string') {
      throw invalid('invalid_input', input);
    }
    const forwarded = readForwardedProps(input.forwardedProps);
    const actor = await this.actorResolver.resolve(req);
    const warnings: string[] = [];
    if (Array.isArray(input.tools) && input.tools.length > 0) {
      warnings.push('Frontend tools are not supported by this agent: the tools list was ignored.');
    }
    const quiet = this.quietMs !== undefined ? { quietMs: this.quietMs } : {};

    if (input.resume !== undefined && input.resume.length > 0) {
      const plan = planResume(input.resume);
      if (typeof plan === 'string') {
        throw invalid('invalid_resume', plan);
      }
      for (const id of plan.unrecognised) {
        warnings.push(`The resume entry ${id} answers an interrupt this agent did not raise.`);
      }
      const first = plan.decisions[0];
      // Independent proposals do not park their run: deciding them is the whole answer.
      if (first !== undefined && plan.decisions.every((d) => d.address.kind === 'proposal')) {
        const decided = await this.decideProposals(actor, plan.decisions);
        this.writeEvents(res, [
          ...warningEvents(warnings),
          ...decided.flatMap((outcome, index) =>
            actionProposalDecisionEvents({
              threadId: input.threadId,
              runId: index === 0 ? input.runId : `${input.runId}:${index}`,
              text: outcome.text,
              proposalDecision: outcome.proposalDecision,
            }),
          ),
        ]);
        return;
      }
      // A list that answers nothing this agent asked continues nothing: an ordinary run.
      if (first !== undefined) {
        const streamRunId = first.address.stream;
        await this.agent.assertResumable(actor, streamRunId);
        await this.settle(actor, plan.decisions);
        await this.pipe(res, streamRunId, {
          threadId: input.threadId,
          runId: input.runId,
          streamRunId,
          skip: first.address.position,
          answered: plan.decisions.map((decision) => decision.address.toolCallId),
          ...quiet,
          preamble: warningEvents(warnings),
        });
        return;
      }
    }

    const turn = readUserTurn(input.messages);
    if (turn === null) {
      throw invalid('no_user_message', 'messages carries no user message to answer');
    }
    warnings.push(...turn.dropped);
    // The consumer names the conversation. A thread it already has is continued (its owner checked,
    // as on `chat`); one nobody has is created under that name.
    const owner = await this.agent.threadOwner(input.threadId);
    if (owner !== null && owner !== actor.id) {
      throw new ForbiddenException('thread belongs to another actor');
    }
    if (owner !== null && turn.media.length === 0) {
      const decision = await this.agent.handleTextDecision(input.threadId, actor, turn.text);
      if ('proposalDecision' in decision) {
        this.writeEvents(res, [
          ...warningEvents(warnings),
          ...actionProposalDecisionEvents({
            threadId: input.threadId,
            runId: input.runId,
            text: decision.text,
            proposalDecision: decision.proposalDecision,
          }),
        ]);
        return;
      }
    }
    const refs = await this.stage(actor, turn.media, warnings);
    if (turn.text.trim().length === 0 && refs.length === 0) {
      throw invalid('no_user_message', 'the user message to answer is empty');
    }
    const context = readContext(input.context);
    const pageContext: PageContext | undefined =
      forwarded.pageContext !== undefined || context !== undefined
        ? {
            ...forwarded.pageContext,
            ...(context !== undefined ? { agUiContext: context } : {}),
          }
        : undefined;
    const started = await this.agent.chat({
      actor,
      message: turn.text,
      ...(owner !== null ? { threadId: input.threadId } : { newThreadId: input.threadId }),
      ...(forwarded.agent !== undefined ? { agentName: forwarded.agent } : {}),
      ...(forwarded.persona !== undefined ? { personaId: forwarded.persona } : {}),
      ...(forwarded.model !== undefined ? { model: forwarded.model } : {}),
      ...(forwarded.uiCapabilities !== undefined
        ? { uiCapabilities: forwarded.uiCapabilities }
        : {}),
      ...(pageContext !== undefined ? { pageContext } : {}),
      ...(refs.length > 0 ? { attachments: refs } : {}),
    });
    await this.pipe(res, started.runId, {
      threadId: input.threadId,
      runId: input.runId,
      streamRunId: started.runId,
      streamThreadId: started.threadId,
      ...quiet,
      preamble: warningEvents(warnings),
    });
  }

  /** Stage the turn's inline media through the bound store, within its limits; say what was not used. */
  private async stage(
    actor: Actor,
    media: readonly InlineMedia[],
    warnings: string[],
  ): Promise<AttachmentRef[]> {
    const refs: AttachmentRef[] = [];
    const limits = attachmentLimits(this.options, this.staging);
    for (const item of media) {
      const label = `The ${item.kind} "${item.filename}" was not used`;
      if (this.staging === undefined) {
        warnings.push(`${label}: attachments are not enabled on this agent.`);
      } else if (refs.length >= limits.maxPerMessage) {
        warnings.push(`${label}: a message carries at most ${limits.maxPerMessage} attachments.`);
      } else if (!limits.allowedContentTypes.includes(item.contentType)) {
        warnings.push(`${label}: ${item.contentType} is not an accepted type.`);
      } else if (item.data.length > limits.maxBytes) {
        warnings.push(`${label}: it is larger than ${limits.maxBytes} bytes.`);
      } else {
        try {
          const staged = await this.staging.stage({
            data: item.data,
            filename: item.filename,
            contentType: item.contentType,
            sizeBytes: item.data.length,
            actor,
          });
          refs.push({ mediaId: staged.mediaId });
        } catch {
          warnings.push(`${label}: it could not be stored.`);
        }
      }
    }
    return refs;
  }

  /**
   * Deliver what a resume list decided, through the same calls the native decision routes make.
   * Everything that can refuse — who may decide, an answer a question's rules reject, a payload that
   * says nothing — is checked for EVERY entry before the first one is delivered, so a list with one
   * bad entry settles nothing.
   */
  private async settle(actor: Actor, decisions: ResumeDecision[]): Promise<void> {
    const deliveries: (() => Promise<void>)[] = [];
    const proposals = decisions.filter((decision) => decision.address.kind === 'proposal');
    for (const { address, entry } of decisions) {
      const { toolCallId } = address;
      const abandoned = entry.status === 'cancelled';
      if (address.kind === 'proposal') continue;
      if (address.kind === 'approval') {
        await this.agent.checkDecision(actor, toolCallId);
        const decision: { approved: boolean; reason?: string; remember?: boolean } | null =
          abandoned ? { approved: false } : readApprovalPayload(entry.payload);
        if (decision === null) {
          throw invalid(
            'invalid_resume',
            'an approval is answered with { approved: boolean, reason?, remember? }',
          );
        }
        const reason = rejectReason(decision.reason ?? (abandoned ? 'abandoned' : undefined));
        deliveries.push(() =>
          decision.approved
            ? this.agent.approve(actor, toolCallId, {
                via: AG_UI_VIA,
                ...(decision.remember === true ? { remember: true } : {}),
              })
            : this.agent.reject(actor, toolCallId, reason, { via: AG_UI_VIA }),
        );
        continue;
      }
      if (abandoned) {
        await this.agent.checkAnswer(actor, toolCallId, {});
        deliveries.push(() => this.agent.skip(actor, toolCallId, { via: AG_UI_VIA }));
        continue;
      }
      const read = readAnswersPayload(entry.payload);
      if (read === null) {
        throw invalid(
          'invalid_resume',
          'a question set is answered with { answers: { <questionId>: string[] } }',
        );
      }
      const answers = boundedAnswers(read) ?? {};
      await this.agent.checkAnswer(actor, toolCallId, answers);
      deliveries.push(() => this.agent.answer(actor, toolCallId, answers, { via: AG_UI_VIA }));
    }
    // Settled before the parked calls, like any other delivery: a refused one settles nothing more.
    if (proposals.length > 0) await this.decideProposals(actor, proposals);
    for (const deliver of deliveries) await deliver();
  }

  /**
   * Decide independent proposals through the proposal service — the call the native
   * `action-proposals/:id/approve|reject` routes make — never by signalling the origin run, which
   * is not waiting. Every payload is checked before the first decision; a refusal is the service's
   * own `403`/`404`.
   */
  private async decideProposals(
    actor: Actor,
    decisions: ResumeDecision[],
  ): Promise<{ proposalDecision: unknown; text: string }[]> {
    const planned = decisions.map(({ address, entry }) => {
      const decision =
        entry.status === 'cancelled' ? { approved: false } : readApprovalPayload(entry.payload);
      if (decision === null || address.proposalId === undefined || address.threadId === undefined) {
        throw invalid(
          'invalid_resume',
          'an approval is answered with { approved: boolean, reason?, remember? }',
        );
      }
      return { address, decision };
    });
    const outcomes: { proposalDecision: unknown; text: string }[] = [];
    for (const { address, decision } of planned) {
      outcomes.push(
        await this.agent.decideActionProposal(
          actor,
          address.threadId as string,
          address.proposalId as string,
          {
            decision: decision.approved ? 'approved' : 'rejected',
            via: AG_UI_VIA,
            ...(decision.remember !== undefined ? { remember: decision.remember } : {}),
            ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
          },
        ),
      );
    }
    return outcomes;
  }

  /** Answer with a complete list of events, no run behind them. */
  private writeEvents(res: Response, events: AgUiEvent[]): void {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.flushHeaders();
    for (const event of events) res.write(agUiSse(event));
    res.end();
  }

  /**
   * Pipe a run to the client as AG-UI 1.0 over SSE: one event per `data:` line, from `RUN_STARTED`
   * to the run's terminal event. It ends when the run stops to ask — the library run stays parked,
   * and the request that answers re-attaches to it.
   */
  private async pipe(res: Response, runId: string, options: AgUiStreamOptions): Promise<void> {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Agent-Run-Id', runId);
    res.flushHeaders();
    let terminal = false;
    try {
      const frames = agUiFramesFromNdjson(this.agent.subscribe(runId));
      for await (const event of agUiEvents(frames, options)) {
        if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') terminal = true;
        res.write(agUiSse(event));
      }
    } catch {
      // The stream under the run broke. The status line is long gone, so the failure travels
      // in-stream — and says nothing of what broke, which is the server's to know.
      if (!terminal) {
        res.write(
          agUiSse({
            type: 'RUN_ERROR',
            message: 'The run could not be followed.',
            code: 'run_failed',
          }),
        );
      }
    }
    res.end();
  }
}

/**
 * Serve the agent over AG-UI 1.0 (https://docs.ag-ui.com/spec/1.0): the body of
 * `POST <path>/ag-ui` is a `RunAgentInput`, the answer the run as AG-UI events. A run that stops to
 * ask ends with the interrupt outcome and is continued by a later request carrying `resume`.
 *
 * ```ts
 * AgentModule.forRoot({ model, adapters: [agUiAdapter()] })
 * ```
 *
 * Authenticated by the module's `actorResolver`, guarded by its `guards` and owner-scoped exactly
 * as `chat`, `chat/:runId/stream` and the `tool-call` routes are.
 */
export function agUiAdapter(options: AgUiAdapterOptions = {}): AgentProtocolAdapter {
  const path = (options.path ?? 'ag-ui').replace(/^\/+|\/+$/g, '');
  const quietMs = options.quietMs;

  @Controller()
  class AgUiController extends AgUiRunHandler {
    constructor(
      @Inject(AgentService) agent: AgentService,
      @Inject(AGENT_ACTOR_RESOLVER) actorResolver: ActorResolver,
      @Inject(AGENT_OPTIONS) moduleOptions: AgentModuleOptions,
      @Optional() @Inject(AGENT_ATTACHMENT_STAGING) staging?: AttachmentStagingStore,
    ) {
      super(agent, actorResolver, moduleOptions, staging, quietMs);
    }

    @Post(path)
    @HttpCode(200)
    run(@Req() req: Request, @Res() res: Response, @Body() body: unknown): Promise<void> {
      return this.handle(req, res, body);
    }
  }

  return { name: 'ag-ui', controllers: [AgUiController] };
}
