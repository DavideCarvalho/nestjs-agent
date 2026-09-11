/**
 * Running the processor chains, and the stream buffering an output gate requires. See
 * `./spi/processors.ts` for the seams themselves and the boundary against `HistoryPolicy`.
 */

import {
  DEFAULT_INCREMENTAL_LOOKBACK_CHARS,
  type InputProcessor,
  type ModelAnswer,
  type OutputProcessor,
  type OutputVerdict,
  type ProcessedPrompt,
  type ProcessorContext,
  ProcessorFailedError,
} from './spi/processors.js';
import type { SinkWriter } from './spi/token-stream-sink.js';
import { decodeStreamEvent, encodeStreamEvent } from './stream-events.js';
import type { ToolCallRequest } from './types.js';

/**
 * Holds a model call's stream frames instead of letting them reach the subscriber. `end`/`fail` are
 * swallowed for the same reason `childSinkWriter` swallows them: the loop owns the run's stream
 * lifecycle across however many steps the turn takes, and the model call is one step of it.
 *
 * Frames are kept as the decoded NDJSON LINES rather than the raw `Uint8Array`s so the buffer can
 * ride a durable checkpoint — the gate has to survive a suspend between the model call and the
 * verdict, and bytes do not round-trip through JSON.
 */
export interface FrameBuffer {
  writer: SinkWriter;
  /** Everything written so far, one entry per NDJSON line, in write order. */
  frames(): string[];
}

const decoder = new TextDecoder();

export function createFrameBuffer(): FrameBuffer {
  const frames: string[] = [];
  return {
    writer: {
      write: (chunk) => {
        for (const line of decoder.decode(chunk).split('\n')) {
          if (line.length > 0) {
            frames.push(line);
          }
        }
      },
      end: () => {},
      fail: () => {},
    },
    frames: () => frames,
  };
}

/**
 * The chunks a passed gate releases to the live stream: the held frames, with every text frame
 * collapsed into ONE carrying `text` — the answer as the chain left it, which is the only version
 * anything downstream is allowed to see.
 *
 * A frame that does not decode is dropped along with them. It cannot be forwarded, because a gate
 * that forwards bytes it cannot classify is not a gate: a provider writing bare text into the sink
 * (rather than the `AgentStreamEvent` vocabulary) would otherwise stream the ungated answer past
 * the processor that was supposed to hold it. That is the cost of an output gate for a provider
 * outside the encoded vocabulary, and it is stated in `AgentLoopDeps.outputProcessors`.
 */
export function releaseGatedFrames(frames: readonly string[], text: string): Uint8Array[] {
  const released: Uint8Array[] = [];
  let emitted = false;
  for (const frame of frames) {
    const event = decodeStreamEvent(frame);
    if (event === null || event.kind === 'text') {
      // Substituted in place, so the answer keeps its position relative to the tool-call frames a
      // model interleaves with it.
      if (!emitted && text.length > 0) {
        released.push(encodeStreamEvent({ kind: 'text', text }));
        emitted = true;
      }
      continue;
    }
    released.push(encodeStreamEvent(event));
  }
  if (!emitted && text.length > 0) {
    released.push(encodeStreamEvent({ kind: 'text', text }));
  }
  return released;
}

/**
 * Fold the prompt through each processor in order, every one seeing what the previous one produced.
 * A throw is wrapped so it cannot read as the model call failing — see {@link ProcessorFailedError}.
 */
export async function runInputProcessors(
  processors: readonly InputProcessor[],
  prompt: ProcessedPrompt,
  ctx: ProcessorContext,
): Promise<ProcessedPrompt> {
  let current = prompt;
  for (const processor of processors) {
    try {
      current = await processor.process(current, ctx);
    } catch (error) {
      throw new ProcessorFailedError('input', processor.name, error);
    }
  }
  return current;
}

/** A settled output chain: the answer as the chain left it, plus who refused it if anyone did. */
export interface OutputGateResult {
  /** The text every downstream consumer sees — the stream, the persisted message, the next step. */
  text: string;
  /** Set only on a refusal; the run ends with an `OutputRejectedError` naming these. */
  rejection?: { processor: string; reason: string };
}

/**
 * Fold the answer through each processor in order. The FIRST rejection ends the chain: a later
 * processor has nothing to add about text that is never going anywhere, and running it would bill
 * a moderation call for a turn already refused.
 */
export async function runOutputProcessors(
  processors: readonly OutputProcessor[],
  answer: ModelAnswer,
  ctx: ProcessorContext,
): Promise<OutputGateResult> {
  let text = answer.text;
  for (const processor of processors) {
    let verdict: OutputVerdict;
    try {
      verdict = await processor.process({ text, toolCalls: answer.toolCalls }, ctx);
    } catch (error) {
      throw new ProcessorFailedError('output', processor.name, error);
    }
    if (verdict.action === 'reject') {
      return { text, rejection: { processor: processor.name, reason: verdict.reason } };
    }
    if (verdict.action === 'replace') {
      text = verdict.text;
    }
  }
  return { text };
}

/**
 * Put each suggestion through the output chain on its own, and keep what survives.
 *
 * A follow-up is model-generated text that gets persisted and rendered, so the gate has to see it.
 * What it does NOT get is the chain's usual answer to a refusal — ending the run. The suggestions
 * are produced AFTER the turn's answer has already cleared the same chain, and retracting a cleared
 * answer because a question nobody asked for was refused would make a run's outcome depend on a
 * by-product. Dropping the suggestion removes it just as completely, which is what the refusal was
 * for. A `replace` is honoured; a processor that empties one drops it too, since an empty suggestion
 * is nothing to render.
 *
 * One suggestion at a time rather than the joined list, so a refusal is confined to the one that
 * earned it and a `replace` cannot smear across a neighbour.
 */
export async function gateFollowUps(
  processors: readonly OutputProcessor[],
  followUps: readonly string[],
  ctx: ProcessorContext,
): Promise<string[]> {
  const kept: string[] = [];
  for (const followUp of followUps) {
    const settled = await runOutputProcessors(processors, { text: followUp, toolCalls: [] }, ctx);
    if (settled.rejection === undefined && settled.text.length > 0) {
      kept.push(settled.text);
    }
  }
  return kept;
}

/**
 * How much of a turn's stream an output chain costs the reader.
 *
 * `off` — nothing registered, the model writes straight to the run's sink.
 * `whole` — at least one processor needs the complete answer, so every frame is held until the
 * chain has passed and the answer arrives as one `text` frame.
 * `incremental` — every processor declared {@link IncrementalGating}, so a lookback-bounded prefix
 * is released while the call streams.
 */
export type OutputGateMode = 'off' | 'whole' | 'incremental';

/**
 * ALL or nothing: one undeclared processor puts the whole chain on the whole-answer path. Its
 * author wrote `process` against the complete text, and a chain that ran it on a prefix because a
 * neighbour opted in would be handing it an input it never agreed to read.
 */
export function resolveOutputGateMode(processors: readonly OutputProcessor[]): OutputGateMode {
  if (processors.length === 0) {
    return 'off';
  }
  return processors.every((processor) => processor.incremental !== undefined)
    ? 'incremental'
    : 'whole';
}

/**
 * The chain's window is the WIDEST any member asked for: a release safe for the shortest-sighted
 * processor is not safe for the one that matches longer patterns, and the gate makes one release
 * decision for all of them.
 *
 * An undeclared processor contributes nothing rather than the default — it has no window, because a
 * chain containing one never reaches the incremental path at all.
 */
export function resolveGateLookback(processors: readonly OutputProcessor[]): number {
  let lookback = 0;
  for (const processor of processors) {
    if (processor.incremental !== undefined) {
      lookback = Math.max(
        lookback,
        processor.incremental.lookbackChars ?? DEFAULT_INCREMENTAL_LOOKBACK_CHARS,
      );
    }
  }
  return lookback;
}

/** A live gate over one model call: the sink the model writes to, plus what it let through. */
export interface IncrementalGate {
  /** Hand this to the model instead of the run's writer. */
  writer: SinkWriter;
  /** Resolves once every chunk handed to {@link writer} has been ruled on. */
  settled(): Promise<void>;
  /** The transformed prefix already written to the run's sink. */
  released(): string;
  /** Set once a prefix was refused; nothing further was released after that. */
  rejection(): OutputGateResult['rejection'];
}

/**
 * Releases a model call's answer to `writer` as it arrives, holding back the last `lookbackChars`
 * characters of what the chain produces so a processor can still change them.
 *
 * The chain runs over the whole PREFIX accumulated so far rather than over each new chunk, so a
 * processor always sees well-formed text and never has to reassemble a pattern split across
 * frames — which is what makes {@link IncrementalGating}'s promise a claim about prefixes. It runs
 * once per streamed `text` frame.
 *
 * Only an EXTENSION of what the reader already has is ever written: a chain whose output stops
 * agreeing with its earlier output has broken its promise, and the loop's whole-answer pass reports
 * that rather than this gate papering over it by re-sending a different answer.
 *
 * Frames that are not text are forwarded live, in arrival order. They are not the answer, so the
 * gate does not own them — but it does drop any frame it cannot decode, for the same reason
 * {@link releaseGatedFrames} does: a gate that forwards bytes it cannot classify is not a gate.
 */
export function createIncrementalGate(options: {
  processors: readonly OutputProcessor[];
  ctx: ProcessorContext;
  lookbackChars: number;
  writer: SinkWriter;
}): IncrementalGate {
  const { processors, ctx, lookbackChars, writer } = options;
  let raw = '';
  let released = '';
  let rejection: OutputGateResult['rejection'];
  /** A prefix the chain could not rule on. Text stops flowing; the whole-answer pass decides. */
  let stalled = false;
  const toolCalls: ToolCallRequest[] = [];
  // The model is free to write without awaiting, and a verdict is asynchronous — serialize, or two
  // prefixes race and the reader gets the answer out of order.
  let queue: Promise<void> = Promise.resolve();

  async function advance(): Promise<void> {
    if (raw.length === 0) {
      return;
    }
    let settled: OutputGateResult;
    try {
      settled = await runOutputProcessors(processors, { text: raw, toolCalls }, ctx);
    } catch {
      // Swallowed HERE only: a prefix pass is an early release, not the verdict. The whole-answer
      // pass runs the same chain and surfaces the failure with the processor's name on it.
      stalled = true;
      return;
    }
    if (settled.rejection !== undefined) {
      rejection = settled.rejection;
      return;
    }
    // The window is trimmed off the chain's OUTPUT, not off the text fed to it: a processor that
    // only saw `raw` minus a tail could not match a pattern straddling that cut, and would release
    // the very text it exists to rewrite.
    const candidate = settled.text.slice(0, Math.max(0, settled.text.length - lookbackChars));
    if (candidate.length <= released.length || !candidate.startsWith(released)) {
      return;
    }
    const delta = candidate.slice(released.length);
    released = candidate;
    await writer.write(encodeStreamEvent({ kind: 'text', text: delta }));
  }

  async function handle(chunk: Uint8Array): Promise<void> {
    for (const line of decoder.decode(chunk).split('\n')) {
      if (line.length === 0) {
        continue;
      }
      const event = decodeStreamEvent(line);
      if (event === null || rejection !== undefined) {
        continue;
      }
      if (event.kind === 'text') {
        raw += event.text;
        if (!stalled) {
          await advance();
        }
        continue;
      }
      if (event.kind === 'tool-input-available') {
        toolCalls.push({ id: event.id, name: event.name, input: event.input });
      }
      await writer.write(encodeStreamEvent(event));
    }
  }

  return {
    writer: {
      write: (chunk) => {
        queue = queue.then(() => handle(chunk));
        return queue;
      },
      end: () => {},
      fail: () => {},
    },
    settled: () => queue,
    released: () => released,
    rejection: () => rejection,
  };
}

/**
 * The tail an incremental gate still owes the reader once the whole-answer pass has settled: the
 * authoritative text minus the prefix already released.
 *
 * Throws when the settled answer is not an extension of that prefix. That check is the reason the
 * final pass stays authoritative for both the stream and the store rather than the stream being
 * stitched together from per-prefix results: agreement between what was streamed and what was
 * stored becomes structural instead of assumed.
 */
export function gateTail(
  processors: readonly OutputProcessor[],
  released: string,
  text: string,
): string {
  if (!text.startsWith(released)) {
    throw new ProcessorFailedError(
      'output',
      processors.map((processor) => processor.name).join(' → '),
      new Error(
        `the gated answer is not an extension of the ${released.length} characters this chain already released — a processor that declares "incremental" promises its result on a prefix stays a prefix of its result on the whole answer, outside the last lookbackChars`,
      ),
    );
  }
  return text.slice(released.length);
}
