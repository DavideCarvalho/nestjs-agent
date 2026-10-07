import {
  type AgentRunInput,
  type AgentRunStartOptions,
  type AgentRunner,
  type Decision,
  type HumanReply,
  RunCancelledError,
} from '@dudousxd/nestjs-agent-core';
import { Inject, Injectable } from '@nestjs/common';
import { OPENCODE_OPTIONS } from './tokens.js';
import { OpenCodeReplyMismatchError, errorText, isDecision } from './turn.js';
import { type OpenCodeEngineSettings, OpenCodeTurns } from './turns.js';

/**
 * Runs OpenCode turns in this process: `begin → prompt → [observe → wait for a person → reply]* →
 * settle`, with the waits on people held in memory. Like `InlineAgentRunner`, a run parked on a
 * person lives in this process, so deploy it single-replica — or use `openCodeDurable()`
 * (`@dudousxd/nestjs-agent-opencode/durable`), which checkpoints every step and waits on a durable
 * signal.
 */
@Injectable()
export class OpenCodeAgentRunner implements AgentRunner {
  private readonly live = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly pending = new Map<
    string,
    {
      on: 'approval' | 'answers';
      resolve: (reply: HumanReply) => void;
      reject: (error: unknown) => void;
    }
  >();

  constructor(
    private readonly turns: OpenCodeTurns,
    @Inject(OPENCODE_OPTIONS) private readonly settings: OpenCodeEngineSettings,
  ) {
    turns.startNext = (next, runId) => this.start(next, { runId });
  }

  runIdFor(input: AgentRunInput): string {
    return this.settings.runId?.(input) ?? crypto.randomUUID();
  }

  async isRunActive(runId: string): Promise<boolean> {
    if (this.live.has(runId)) return true;
    for (const key of this.pending.keys()) if (key.startsWith(`${runId}:`)) return true;
    return false;
  }

  async start(
    input: AgentRunInput,
    options: AgentRunStartOptions = {},
  ): Promise<{ runId: string }> {
    const runId = options.runId ?? this.runIdFor(input);
    this.live.add(runId);
    void this.run(runId, input).finally(() => {
      this.live.delete(runId);
      this.cancelled.delete(runId);
      for (const key of [...this.pending.keys()])
        if (key.startsWith(`${runId}:`)) this.pending.delete(key);
    });
    return { runId };
  }

  /**
   * Deliver a person's reply. Answers addressed at an approval are refused
   * ({@link OpenCodeReplyMismatchError}, a 409) and the approval keeps waiting: they say nothing
   * about whether the action should run.
   */
  async signal(runId: string, toolCallId: string, reply: HumanReply): Promise<void> {
    const key = `${runId}:${toolCallId}`;
    const waiter = this.pending.get(key);
    if (waiter === undefined) return;
    if (waiter.on === 'approval' && !isDecision(reply)) {
      throw new OpenCodeReplyMismatchError(runId, toolCallId);
    }
    this.pending.delete(key);
    waiter.resolve(reply);
  }

  /**
   * Stop the run: what it waits on a person for is dropped, and OpenCode is interrupted — it answers
   * `session.execution.interrupted`, which settles the run as cancelled.
   */
  async cancel(runId: string): Promise<void> {
    this.cancelled.add(runId);
    for (const [key, waiter] of [...this.pending]) {
      if (!key.startsWith(`${runId}:`)) continue;
      this.pending.delete(key);
      waiter.reject(new RunCancelledError());
    }
    const input = this.inputs.get(runId);
    if (input !== undefined) await this.turns.interrupt(input).catch(() => undefined);
  }

  private readonly inputs = new Map<string, AgentRunInput>();

  private async run(runId: string, input: AgentRunInput): Promise<void> {
    const started = Date.now();
    this.inputs.set(runId, input);
    try {
      let handle = await this.turns.begin(runId, input);
      if (this.cancelled.has(runId)) throw new RunCancelledError();
      await this.turns.prompt(runId, input, handle);
      for (;;) {
        const milestone = await this.turns.observe(runId, input, handle);
        if (milestone.kind === 'finished') {
          await this.turns.settle(runId, input, milestone.outcome, Date.now() - started);
          return;
        }
        const reply = await this.park(
          runId,
          milestone.ask.id,
          milestone.ask.kind === 'approval' ? 'approval' : 'answers',
          milestone.timeoutMs,
        );
        handle = await this.turns.reply(runId, input, handle, milestone.ask, reply);
      }
    } catch (error) {
      if (error instanceof RunCancelledError) {
        await this.turns.interrupt(input).catch(() => undefined);
        await this.turns.settle(runId, input, { status: 'interrupted' }, Date.now() - started);
        return;
      }
      await this.turns.settleFailed(runId, input, errorText(error, 'the turn failed'));
    } finally {
      this.inputs.delete(runId);
    }
  }

  /** Wait for a person's answer; a lapsed approval answers itself as expired. */
  private park(
    runId: string,
    toolCallId: string,
    on: 'approval' | 'answers',
    timeoutMs?: number,
  ): Promise<HumanReply> {
    const key = `${runId}:${toolCallId}`;
    const waiting = new Promise<HumanReply>((resolve, reject) => {
      this.pending.set(key, { on, resolve, reject });
    });
    if (timeoutMs === undefined) return waiting;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lapse = new Promise<Decision>((resolve) => {
      timer = setTimeout(() => {
        if (!this.pending.has(key)) return;
        this.pending.delete(key);
        resolve({ approved: false, expired: true });
      }, timeoutMs);
      timer.unref?.();
    });
    return Promise.race([waiting, lapse]).finally(() => clearTimeout(timer));
  }
}
