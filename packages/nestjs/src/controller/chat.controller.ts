import {
  AGENT_ACTOR_RESOLVER,
  type ActorResolver,
  AgentStreamError,
  type AttachmentRef,
  type PageContext,
  streamFailure,
} from '@dudousxd/nestjs-agent-core';
import { type UiCapabilities, validateUiCapabilities } from '@dudousxd/nestjs-agent-core/genui';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AgentService, type ChatSendMode } from '../agent.service.js';
import { MAX_ATTACHMENTS_PER_MESSAGE } from '../attachment-limits.js';

interface ChatBody {
  uiCapabilities?: unknown;
  message: string;
  threadId?: string;
  /** Name of the agent to run (orchestrator or a sub-agent). Defaults to the module's default. */
  agent?: string;
  /**
   * One of the agent's personas (`@Agent({ personas })`) to answer as — pinned on the thread. 400
   * `persona_not_found` when the agent declares none by that id.
   */
  persona?: string;
  /**
   * Files attached to this message (image/PDF), named by the `mediaId` `POST /agent/attachments`
   * (or the host's own upload) returned. Any other field sent alongside it is ignored.
   */
  attachments?: unknown;
  pageContext?: PageContext;
  /** Re-run the last exchange on `threadId` instead of adding a new message. */
  regenerate?: boolean;
  /** Start a new thread transient (hidden from history until promoted). Ignored with `threadId`. */
  transient?: boolean;
  /** Run this turn on a catalog model (see `GET models`) instead of the thread's pinned one. */
  model?: string;
  /**
   * What to do when the thread already has a turn running: `'auto'` (default) queues it, `'queue'`
   * always queues it (behind anything already waiting), `'interrupt'` cancels the running turn and
   * runs this next. See `ChatSendMode`.
   */
  mode?: unknown;
  /** Shorthand for `mode: 'interrupt'`. */
  interrupt?: boolean;
}

/** The send mode a body asked for, or a 400. */
function sendMode(body: ChatBody): ChatSendMode {
  if (body.interrupt === true) {
    return 'interrupt';
  }
  if (body.mode === undefined || body.mode === null) {
    return 'auto';
  }
  if (body.mode === 'auto' || body.mode === 'queue' || body.mode === 'interrupt') {
    return body.mode;
  }
  throw new BadRequestException("mode must be 'auto', 'queue' or 'interrupt'");
}

/**
 * Reduce whatever the body sent to the ids alone. A client cannot describe an attachment, only
 * point at one it staged: the url the model provider will fetch is resolved server-side from the
 * id (see `AgentService.chat`), so anything else here would be an SSRF the caller writes.
 */
export function attachmentRefs(claimed: unknown): AttachmentRef[] {
  if (claimed === undefined) {
    return [];
  }
  if (!Array.isArray(claimed)) {
    throw new BadRequestException('attachments must be an array of { mediaId }');
  }
  if (claimed.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new BadRequestException(
      `a message may carry at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`,
    );
  }
  return claimed.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || !('mediaId' in entry)) {
      throw new BadRequestException('each attachment must be an object with a mediaId');
    }
    // One shape: a ref names an upload, nothing more. A full attachment (url, name, …) is refused
    // rather than trimmed, so a client that still sends one learns it instead of relying on it.
    if (Object.keys(entry).some((key) => key !== 'mediaId')) {
      throw new BadRequestException('attachments are { mediaId } refs — send nothing but the id');
    }
    const { mediaId } = entry as { mediaId: unknown };
    if (typeof mediaId !== 'string' || mediaId.length === 0) {
      throw new BadRequestException('each attachment must carry a non-empty string mediaId');
    }
    return { mediaId };
  });
}

@Controller()
export class ChatController {
  constructor(
    private readonly agent: AgentService,
    @Inject(AGENT_ACTOR_RESOLVER) private readonly actorResolver: ActorResolver,
  ) {}

  /**
   * Start a turn and stream it — or, when the thread already has one running, queue the message and
   * answer `202 { queued: true, messageId, position, queue, … }` (JSON, no stream): it runs when the
   * turn ahead of it settles, and the stream of the run holding the thread announces it with a
   * `queue` frame.
   */
  @Post('chat')
  async chat(@Req() req: Request, @Res() res: Response, @Body() body: ChatBody): Promise<void> {
    const actor = await this.actorResolver.resolve(req);
    const attachments = attachmentRefs(body.attachments);
    const mode = sendMode(body);
    let uiCapabilities: UiCapabilities | undefined;
    try {
      uiCapabilities =
        body.uiCapabilities === undefined ? undefined : validateUiCapabilities(body.uiCapabilities);
    } catch {
      throw new BadRequestException('Invalid UI capabilities');
    }
    const result = await this.agent.send({
      actor,
      message: body.message,
      ...(uiCapabilities !== undefined ? { uiCapabilities } : {}),
      ...(body.threadId !== undefined ? { threadId: body.threadId } : {}),
      ...(body.agent !== undefined ? { agentName: body.agent } : {}),
      ...(typeof body.persona === 'string' && body.persona.length > 0
        ? { personaId: body.persona }
        : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(body.pageContext !== undefined ? { pageContext: body.pageContext } : {}),
      ...(body.regenerate === true ? { regenerate: true } : {}),
      ...(body.transient === true ? { transient: true } : {}),
      ...(typeof body.model === 'string' && body.model.length > 0 ? { model: body.model } : {}),
      mode,
    });
    if ('proposalDecision' in result) {
      res.status(200).json(result);
      return;
    }
    if (result.queued === true) {
      res.status(202).json(result);
      return;
    }
    const { runId, threadId } = result;
    // The run was just started for this actor, so no ownership read is needed — and one would race
    // the run itself, which clears the thread's active stream (what ownership is derived from) the
    // moment it finishes.
    await this.pipe(res, runId, this.agent.subscribe(runId), threadId);
  }

  /**
   * Attach to a run's stream: every buffered frame, then live ones. `?after=<seq>` (or the SSE
   * `Last-Event-ID` header a browser `EventSource` sends on its own) skips the frames a reconnecting
   * client already has — see {@link pipe} for how frames are numbered.
   */
  @Get('chat/:runId/stream')
  async stream(
    @Req() req: Request,
    @Param('runId') runId: string,
    @Res() res: Response,
    @Query('after') after?: string,
  ): Promise<void> {
    const actor = await this.actorResolver.resolve(req);
    const cursor = parseCursor(after) ?? parseCursor(req.headers['last-event-id']) ?? 0;
    await this.pipe(res, runId, await this.agent.subscribeAs(actor, runId), undefined, cursor);
  }

  @Post('chat/:runId/cancel')
  async cancel(@Req() req: Request, @Param('runId') runId: string): Promise<{ aborted: boolean }> {
    const actor = await this.actorResolver.resolve(req);
    await this.agent.cancel(actor, runId);
    return { aborted: true };
  }

  /**
   * Every `data:` frame carries an SSE `id:` — its 1-based sequence number within the run. The
   * number is a pure function of the run's buffered stream (every sink replays a run from its first
   * chunk, in write order), so the same frame gets the same number on the POST that started the run
   * and on any later `GET …/stream`, whichever replica serves it. A reconnecting client passes the
   * last one it saw as `?after=`; frames at or below it are read off the sink but not re-sent.
   * `meta`, `done` and `error` carry no id: `meta` is re-sent on every attach, the terminals once.
   */
  private async pipe(
    res: Response,
    runId: string,
    events: AsyncIterable<Uint8Array>,
    threadId?: string,
    after = 0,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Agent-Run-Id', runId);
    if (threadId !== undefined) {
      res.setHeader('X-Agent-Thread-Id', threadId);
    }
    res.write(`event: meta\ndata: ${JSON.stringify({ runId, threadId })}\n\n`);
    // The sink now carries NDJSON `AgentStreamEvent`s (one `{...}\n` per write). Forward each line
    // as an SSE `data:` frame verbatim — the client transport maps them to the AI SDK UI-message
    // chunk protocol. Buffer across chunk boundaries in case a transport batches multiple writes.
    const decoder = new TextDecoder();
    let buffer = '';
    let seq = 0;
    const forward = (line: string) => {
      seq += 1;
      if (seq > after) {
        res.write(`id: ${seq}\ndata: ${line}\n\n`);
      }
    };
    try {
      for await (const chunk of events) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) {
            forward(line);
          }
          newline = buffer.indexOf('\n');
        }
      }
      if (buffer.length > 0) {
        forward(buffer);
      }
      res.write('event: done\ndata: {}\n\n');
    } catch (error) {
      // A run that failed terminates the sink with an AgentStreamError; surface it as a typed
      // error frame so the client can render a failure state instead of parsing it as a token.
      const payload =
        error instanceof AgentStreamError
          ? { code: error.code, message: error.message }
          : streamFailure(error);
      res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
    }
    res.end();
  }
}

/** A non-negative integer sequence cursor, or `undefined` for anything else (absent, malformed). */
function parseCursor(raw: unknown): number | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    return undefined;
  }
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
