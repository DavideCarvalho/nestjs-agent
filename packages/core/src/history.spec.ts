import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HISTORY_SUMMARY_INSTRUCTION,
  estimateMessageTokens,
  summarizeWithModel,
  windowHistory,
} from './history.js';
import type { HistoryPolicyContext } from './spi/history-policy.js';
import type { ModelProvider, ModelTurnArgs } from './spi/model-provider.js';
import type { ModelMessage } from './types.js';

const CTX: HistoryPolicyContext = { threadId: 't1', actor: { id: 'u1' } };

/** `count` alternating user/assistant messages, contents `m0`…`m<count-1>`. */
function thread(count: number): ModelMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `m${index}`,
  }));
}

function contents(messages: ModelMessage[]): string[] {
  return messages.map((message) => message.content);
}

describe('windowHistory', () => {
  it('with no limit set, keeps the whole thread — the same messages an unconfigured loop sends', () => {
    const messages = thread(5);
    expect(windowHistory({}).select(messages, CTX)).toEqual({ keep: messages, drop: [] });
  });

  it('keeps the newest `maxMessages` and reports the rest as dropped, oldest-first', () => {
    const { keep, drop } = windowHistory({ maxMessages: 3 }).select(thread(7), CTX);
    expect(contents(keep)).toEqual(['m4', 'm5', 'm6']);
    expect(contents(drop)).toEqual(['m0', 'm1', 'm2', 'm3']);
  });

  it('drops nothing when the thread is already inside the window', () => {
    expect(windowHistory({ maxMessages: 10 }).select(thread(4), CTX).drop).toEqual([]);
  });

  it('keeps the newest messages that fit `maxTokens`, measured by the supplied estimate', () => {
    // 10 tokens each, so a 25-token budget fits exactly two.
    const { keep, drop } = windowHistory({ maxTokens: 25, estimate: () => 10 }).select(
      thread(6),
      CTX,
    );
    expect(contents(keep)).toEqual(['m4', 'm5']);
    expect(contents(drop)).toEqual(['m0', 'm1', 'm2', 'm3']);
  });

  it('applies both limits — whichever cuts more wins', () => {
    const messages = thread(8);
    const estimate = () => 10;
    // Tokens allow 4, the count allows 2.
    expect(
      contents(
        windowHistory({ maxMessages: 2, maxTokens: 45, estimate }).select(messages, CTX).keep,
      ),
    ).toEqual(['m6', 'm7']);
    // Tokens allow 2, the count allows 5.
    expect(
      contents(
        windowHistory({ maxMessages: 5, maxTokens: 25, estimate }).select(messages, CTX).keep,
      ),
    ).toEqual(['m6', 'm7']);
  });

  it('always keeps the newest message, even when it alone busts the budget', () => {
    // A turn with nothing to answer is worse than a turn over budget.
    const { keep, drop } = windowHistory({ maxTokens: 1, estimate: () => 500 }).select(
      thread(4),
      CTX,
    );
    expect(contents(keep)).toEqual(['m3']);
    expect(contents(drop)).toEqual(['m0', 'm1', 'm2']);
    expect(contents(windowHistory({ maxMessages: 0 }).select(thread(3), CTX).keep)).toEqual(['m2']);
  });

  it('handles an empty thread without inventing a message to keep', () => {
    expect(windowHistory({ maxMessages: 3 }).select([], CTX)).toEqual({ keep: [], drop: [] });
  });

  it('exposes `summarize` only when one was supplied', () => {
    expect(windowHistory({ maxMessages: 2 }).summarize).toBeUndefined();
    expect(
      windowHistory({ maxMessages: 2, summarize: async () => ({ text: 'x' }) }).summarize,
    ).toBeTypeOf('function');
  });
});

describe('estimateMessageTokens', () => {
  it('grows with the content and counts a message with tool calls as more than its text alone', () => {
    const plain: ModelMessage = { role: 'assistant', content: 'hello' };
    const withCalls: ModelMessage = {
      role: 'assistant',
      content: 'hello',
      toolCalls: [{ id: 'c1', name: 'getWeather', input: { city: 'Recife' } }],
      toolResults: [{ id: 'c1', name: 'getWeather', output: { tempC: 21 } }],
    };
    expect(estimateMessageTokens({ role: 'user', content: 'x'.repeat(400) })).toBeGreaterThan(
      estimateMessageTokens({ role: 'user', content: 'x'.repeat(40) }),
    );
    expect(estimateMessageTokens(withCalls)).toBeGreaterThan(estimateMessageTokens(plain));
  });
});

describe('summarizeWithModel', () => {
  it('sends the dropped messages to the model and reports the call it made', async () => {
    let seen: ModelTurnArgs | undefined;
    const model: ModelProvider = {
      runTurn: async (args) => {
        seen = args;
        // A summarizer must not leak into the user's live stream — writing here proves the sink it
        // was handed is a discarding one, since nothing in this test subscribes to a real sink.
        await args.sink.write(new TextEncoder().encode('partial'));
        return {
          text: 'they discussed Recife',
          toolCalls: [],
          usage: { inputTokens: 40, outputTokens: 5 },
          modelId: 'summarizer-1',
        };
      },
    };
    const dropped = thread(3);
    const summary = await summarizeWithModel(model)(dropped, CTX);
    expect(summary).toEqual({
      text: 'they discussed Recife',
      usage: { inputTokens: 40, outputTokens: 5 },
      modelId: 'summarizer-1',
    });
    expect(seen?.messages).toEqual(dropped);
    expect(seen?.tools).toEqual([]);
    expect(seen?.system).toBe(DEFAULT_HISTORY_SUMMARY_INSTRUCTION);
  });

  it('uses a custom instruction when given one', async () => {
    let seen: ModelTurnArgs | undefined;
    const model: ModelProvider = {
      runTurn: async (args) => {
        seen = args;
        return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    await summarizeWithModel(model, 'be terse')([], CTX);
    expect(seen?.system).toBe('be terse');
  });
});
