import type {
  ModelProvider,
  ModelTurnArgs,
  ModelTurnResult,
} from '@dudousxd/nestjs-agent-core';

export interface FakeTurn {
  text: string;
  /** If set, the turn asks to call this tool instead of finishing. */
  toolCall?: { name: string; input: unknown };
}

/**
 * `turnIndex` = how many assistant turns have already happened this run (derived from the
 * message history), so the script is a pure function of its inputs — deterministic and
 * replay-safe with no internal counter.
 */
export type FakeScript = (args: ModelTurnArgs, turnIndex: number) => FakeTurn;

/**
 * A deterministic, offline `ModelProvider`. Drives the agent loop without any API key,
 * streaming the scripted text to the sink and optionally requesting one tool call.
 */
export class FakeModelProvider implements ModelProvider {
  constructor(private readonly script: FakeScript) {}

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const turnIndex = args.messages.filter((message) => message.role === 'assistant').length;
    const turn = this.script(args, turnIndex);

    const encoder = new TextEncoder();
    await args.sink.write(encoder.encode(turn.text));

    const toolCalls = turn.toolCall
      ? [
          {
            id: `call-${turnIndex}-${turn.toolCall.name}`,
            name: turn.toolCall.name,
            input: turn.toolCall.input,
          },
        ]
      : [];

    return {
      text: turn.text,
      toolCalls,
      usage: { inputTokens: args.messages.length, outputTokens: turn.text.length },
    };
  }
}

/** A trivial script: stream a fixed reply and never call a tool. */
export function echoScript(reply = 'ok'): FakeScript {
  return () => ({ text: reply });
}
