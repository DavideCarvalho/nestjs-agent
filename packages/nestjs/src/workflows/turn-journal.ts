import {
  OutputRejectedError,
  QuotaExceededError,
  RunCancelledError,
  StructuredOutputError,
} from '@dudousxd/nestjs-agent-core';
import { isWorkflowInterrupt } from '@nestjs/workflows';

/**
 * The marker core's loop reads to tell a runner unwinding the turn from a failure (see
 * `isControlFlowSignal` in core). `@nestjs/workflows` interrupts carry none, so every `ctx` call
 * this engine makes stamps it on the interrupt it throws: then every `catch` in the loop, the ones
 * that consult `isControlFlowError` and the ones that only read the marker, lets it through.
 */
const CONTROL_FLOW_SIGNAL = Symbol.for('aviary:durable:control-flow');

/** Mark `error` as control flow when it is a `@nestjs/workflows` interrupt (a suspend, a cancel...). */
export function markControlFlow(error: unknown): unknown {
  if (isWorkflowInterrupt(error) && typeof error === 'object' && error !== null) {
    (error as { [CONTROL_FLOW_SIGNAL]?: boolean })[CONTROL_FLOW_SIGNAL] = true;
  }
  return error;
}

/**
 * Thrown when an instance has made its share of model calls (`stepsPerInstance`): the turn goes on
 * in a child instance. Control flow, never a failure.
 */
export class SegmentBoundary extends Error {
  constructor() {
    super('The turn goes on in a child workflow instance');
    this.name = 'SegmentBoundary';
    (this as unknown as { [CONTROL_FLOW_SIGNAL]: boolean })[CONTROL_FLOW_SIGNAL] = true;
  }
}

/** Is this the engine unwinding the turn rather than something the agent did? */
export function isEngineControlFlow(error: unknown): boolean {
  return isWorkflowInterrupt(error) || error instanceof SegmentBoundary;
}

/** An error as JSON: its name, its message and its own JSON-safe fields (a `code`, a `status`). */
export interface SerializedTurnError {
  name: string;
  message: string;
  props?: Record<string, unknown>;
}

/** What one journaled operation came to: its value, or the error it threw. */
export type TurnOutcome = { v?: unknown } | { e: SerializedTurnError };

export function serializeTurnError(error: unknown): SerializedTurnError {
  if (!(error instanceof Error)) {
    return { name: 'Error', message: String(error) };
  }
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error)) {
    if (key === 'name' || key === 'message' || key === 'stack') continue;
    try {
      const json = JSON.stringify(value);
      if (json !== undefined) props[key] = JSON.parse(json);
    } catch {
      // Not JSON: left out, as a journal would.
    }
  }
  return {
    name: error.name,
    message: error.message,
    ...(Object.keys(props).length > 0 ? { props } : {}),
  };
}

/**
 * The failure a `StepFailedError` gave up on — its `cause`, the step's error as the journal kept it
 * (`{ name, message }`). Read defensively: a cause that is missing or not that shape (an older
 * journal, an engine change) falls back to the cause as text, or to the step error's own message,
 * rather than throwing a `TypeError` in place of the turn's real failure.
 */
export function stepFailureCause(error: { cause?: unknown; message: string }): SerializedTurnError {
  const cause = error.cause;
  if (typeof cause === 'object' && cause !== null) {
    const { name, message } = cause as { name?: unknown; message?: unknown };
    if (typeof message === 'string') {
      return { name: typeof name === 'string' ? name : 'Error', message };
    }
  }
  if (cause === undefined || cause === null) return { name: 'Error', message: error.message };
  return { name: 'Error', message: typeof cause === 'string' ? cause : safeString(cause) };
}

function safeString(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Core's errors the runners branch on by class (`agentFailureCode`), rebuilt as themselves. */
const KNOWN_ERRORS: Record<string, { prototype: Error }> = {
  QuotaExceededError,
  RunCancelledError,
  OutputRejectedError,
  StructuredOutputError,
};

/** The error a journal recorded, as an `Error` again (of core's own class, when it is one). */
export function rebuildTurnError(serialized: SerializedTurnError): Error {
  const prototype = KNOWN_ERRORS[serialized.name]?.prototype ?? Error.prototype;
  const error = Object.create(prototype) as Error;
  Object.assign(error, serialized.props ?? {});
  Object.defineProperty(error, 'name', {
    value: serialized.name,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(error, 'message', {
    value: serialized.message,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(error, 'stack', {
    value: `${serialized.name}: ${serialized.message}`,
    writable: true,
    configurable: true,
  });
  return error;
}

/**
 * The turn's view of its journal, over `@nestjs/workflows`.
 *
 * NAMES. The engine wants every step, wait and child name unique per run; the loop's checkpoint
 * names are unique per call site, not per run (two delegations to one agent both create a
 * `subthread:<agent>`). {@link unique} numbers repeats in CALL order (`name`, `name#2`, ...): the
 * loop invokes its parallel tasks synchronously in list order, so the numbering is the same on every
 * replay.
 *
 * SEGMENTS. A turn that runs past `stepsPerInstance` model calls goes on in a child instance, which
 * replays the loop from the top. What the parent's operations came to is handed to the child as
 * `carried`, and {@link op} answers a carried name from it without touching the child's journal, so
 * each instance's journal holds only the operations of its own segment.
 */
export class TurnJournal {
  private readonly counts = new Map<string, number>();
  /** Every operation's outcome so far: the carried ones, then this instance's. */
  readonly outcomes: Record<string, TurnOutcome>;
  /** Model calls this instance made itself (not carried). */
  liveModelCalls = 0;

  constructor(carried: Record<string, TurnOutcome> = {}) {
    this.outcomes = { ...carried };
  }

  /** `base` the first time, `base#2` the second, ... */
  unique(base: string): string {
    const count = (this.counts.get(base) ?? 0) + 1;
    this.counts.set(base, count);
    return count === 1 ? base : `${base}#${count}`;
  }

  /** Was `name` carried from an earlier segment, or already settled in this one? */
  has(name: string): boolean {
    return name in this.outcomes;
  }

  /**
   * Run `live` (a `ctx` operation) once per run: a name an earlier segment settled answers from
   * `carried`. A failure is recorded too, so a later segment replays it as the same failure; the
   * engine's own control flow is not.
   */
  async op<T>(name: string, live: () => Promise<T>): Promise<T> {
    const known = this.outcomes[name];
    if (known !== undefined) {
      if ('e' in known) throw rebuildTurnError(known.e);
      return known.v as T;
    }
    try {
      const value = await live();
      this.outcomes[name] = value === undefined ? {} : { v: value };
      return value;
    } catch (error) {
      if (isEngineControlFlow(error)) throw markControlFlow(error);
      this.outcomes[name] = { e: serializeTurnError(error) };
      throw error;
    }
  }
}
