import type { ModelTurnResult } from './spi/model-provider.js';
import type { SinkWriter } from './spi/token-stream-sink.js';
import { type AgentUiComponent, decodeStreamEvent } from './stream-events.js';

/** What a model turn streamed that the persisted message keeps, beyond its text and tool calls. */
export interface TurnFrameSummary {
  reasoning?: string;
  reasoningMs?: number;
  ui?: AgentUiComponent[];
}

export interface ObservedTurnFrames {
  /** Hand THIS to the provider: every write passes through to the wrapped writer unchanged. */
  writer: SinkWriter;
  /** What was seen so far. Closes an open thinking burst at the moment it is called. */
  summary(): TurnFrameSummary;
}

/**
 * Watch the frames a model turn writes, to learn what the stream showed that the provider's result
 * does not carry: the model's thinking (text and how long it took) and any pushed UI components.
 *
 * Derived from the FRAMES rather than asked of each provider, so every provider that streams the
 * vocabulary gets reasoning persisted without implementing anything. Thinking time is the sum of
 * each burst of consecutive `reasoning` frames — from the first one to the next frame that is not
 * reasoning (or the end of the turn) — which is what a reader watched as "thinking".
 *
 * Call it inside the step that runs the model, so the summary rides that step's journaled result
 * and a replay reads the same numbers back instead of re-measuring a turn that is not happening.
 */
export function observeTurnFrames(
  writer: SinkWriter,
  now: () => number = Date.now,
): ObservedTurnFrames {
  const decoder = new TextDecoder();
  let pending = '';
  let reasoning = '';
  let reasoningMs = 0;
  let burstStartedAt: number | undefined;
  const ui = new Map<string, AgentUiComponent>();

  function closeBurst(): void {
    if (burstStartedAt !== undefined) {
      reasoningMs += Math.max(0, now() - burstStartedAt);
      burstStartedAt = undefined;
    }
  }

  function observeLine(line: string): void {
    if (line.trim().length === 0) {
      return;
    }
    const event = decodeStreamEvent(line);
    if (event === null) {
      return;
    }
    if (event.kind === 'reasoning') {
      burstStartedAt ??= now();
      reasoning += event.text;
      return;
    }
    closeBurst();
    if (event.kind === 'ui') {
      // A repeat id replaces the props but keeps the component where it first appeared, exactly as
      // the client's data part does.
      ui.set(event.id, {
        id: event.id,
        component: event.component,
        props: event.props,
        ...(event.version !== undefined ? { version: event.version } : {}),
      });
    }
  }

  function observe(chunk: Uint8Array): void {
    pending += decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      observeLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
  }

  return {
    writer: {
      write(chunk) {
        // Observed before it is forwarded, so a burst closes at the moment the next frame was
        // produced rather than whenever a slow sink got round to accepting it.
        observe(chunk);
        return writer.write(chunk);
      },
      end: () => writer.end(),
      fail: (error) => writer.fail(error),
    },
    summary() {
      if (pending.length > 0) {
        observeLine(pending);
        pending = '';
      }
      closeBurst();
      return {
        ...(reasoning.length > 0 ? { reasoning, reasoningMs: Math.round(reasoningMs) } : {}),
        ...(ui.size > 0 ? { ui: [...ui.values()] } : {}),
      };
    },
  };
}

/** Fill what a provider did not report from what its frames showed. A provider's own value wins. */
export function withTurnFrames<T extends ModelTurnResult>(result: T, frames: TurnFrameSummary): T {
  return {
    ...result,
    ...(result.reasoning === undefined && frames.reasoning !== undefined
      ? { reasoning: frames.reasoning }
      : {}),
    ...(result.reasoningMs === undefined && frames.reasoningMs !== undefined
      ? { reasoningMs: frames.reasoningMs }
      : {}),
    ...(result.ui === undefined && frames.ui !== undefined ? { ui: frames.ui } : {}),
  };
}
