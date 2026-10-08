import {
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  encodeStreamEvent,
} from '@dudousxd/nestjs-agent-core';

/**
 * What a scripted turn asks for. Each requested call's id is `call-<turnIndex>-<name>`, suffixed
 * `-2`, `-3`… when this provider already issued that id (another thread's turn, or a second call to
 * the same tool in one turn): tool call ids are the stores' primary key across every thread.
 */
export interface FakeTurn {
  text: string;
  /** If set, the turn asks to call this tool instead of finishing. */
  toolCall?: { name: string; input: unknown };
  /** If set, the turn asks for several tools at once. Ignored when `toolCall` is set. */
  toolCalls?: { name: string; input: unknown }[];
  /** If set, the turn reports an actual USD cost — as a gateway provider would. */
  costUsd?: number;
}

/**
 * `turnIndex` = how many assistant turns have already happened this run (derived from the
 * message history), so the script is a pure function of its inputs — deterministic and
 * replay-safe with no internal counter.
 */
export type FakeScript = (args: ModelTurnArgs, turnIndex: number) => FakeTurn;

/**
 * A deterministic, offline `ModelProvider`. Drives the agent loop without any API key,
 * streaming the scripted text to the sink — as a `text` stream event, the frame a real provider
 * (`aiSdkModel`) writes and a client renders live — and optionally requesting tool calls.
 */
export class FakeModelProvider implements ModelProvider {
  /** Every call id this instance handed out, so none is issued twice. */
  private readonly issued = new Set<string>();

  constructor(private readonly script: FakeScript) {}

  /** `call-<turnIndex>-<name>` the first time, then the same with the first free `-<n>` suffix. */
  private callId(turnIndex: number, name: string): string {
    const base = `call-${turnIndex}-${name}`;
    let id = base;
    for (let n = 2; this.issued.has(id); n += 1) id = `${base}-${n}`;
    this.issued.add(id);
    return id;
  }

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const turnIndex = args.messages.filter((message) => message.role === 'assistant').length;
    const turn = this.script(args, turnIndex);

    await args.sink.write(encodeStreamEvent({ kind: 'text', text: turn.text }));

    const requested = turn.toolCall !== undefined ? [turn.toolCall] : (turn.toolCalls ?? []);
    const toolCalls = requested.map((call) => ({
      id: this.callId(turnIndex, call.name),
      name: call.name,
      input: call.input,
    }));

    return {
      text: turn.text,
      toolCalls,
      usage: { inputTokens: args.messages.length, outputTokens: turn.text.length },
      ...(turn.costUsd !== undefined ? { costUsd: turn.costUsd } : {}),
    };
  }
}

/** A trivial script: stream a fixed reply and never call a tool. */
export function echoScript(reply = 'ok'): FakeScript {
  return () => ({ text: reply });
}
