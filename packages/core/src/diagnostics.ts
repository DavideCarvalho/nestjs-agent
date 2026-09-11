import { emit } from '@dudousxd/nestjs-diagnostics';
import type { ChannelRegistry } from '@dudousxd/nestjs-diagnostics';

/** Payloads carried on each `aviary:agent:*` channel. */
export interface AgentRunStarted {
  runId: string;
  threadId: string;
  actorId: string;
  /** Which agent is handling the run. */
  agentName?: string;
}
export interface AgentMessageEvent {
  runId: string;
  threadId: string;
  role: 'user' | 'assistant';
  textLength: number;
}
export interface AgentToolCallEvent {
  runId: string;
  toolName: string;
  toolType: 'read' | 'action';
  status: string;
  durationMs?: number;
}
export interface AgentQuotaExceeded {
  actorId: string;
  usedTokens: number;
  limitTokens: number;
}
export interface AgentRunFinished {
  runId: string;
  threadId: string;
  steps: number;
  inputTokens: number;
  outputTokens: number;
}
export interface AgentRunFailed {
  runId: string;
  /** Stable failure slug, e.g. `quota_exceeded` or `run_failed`. */
  code: string;
  message: string;
}
export interface AgentDelegated {
  runId: string;
  fromAgent?: string;
  toAgent: string;
  /** The delegate was STARTED, not awaited — this run's turn ended without its answer. */
  detached?: boolean;
}
export interface AgentRetrieved {
  runId: string;
  query: string;
  /** How many passages the retriever returned. */
  count: number;
}
/**
 * The skills a turn was offered, published once per run at the `skills:catalog` checkpoint. Metadata
 * only — counts and the block's size, never a skill's name or its body.
 */
export interface AgentSkillsResolved {
  runId: string;
  /** How many scope tokens the resolver returned for this turn. */
  scopes: number;
  /** Skills in the catalog block the model was shown. */
  offered: number;
  /** Applicable skills the `maxSkills` ceiling left out — non-zero means the catalog is partial. */
  omitted: number;
  /**
   * Characters the catalog block added to the system prompt. The WHOLE of what skills cost it: a
   * skill's body never enters the system block, it arrives as a tool result on the transcript.
   */
  promptChars: number;
}
/**
 * The memories a turn was shown, published once per run at the `memory:digest` checkpoint. Metadata
 * only — counts and the block's size, never a memory's key or its text. A key is as revealing as a
 * fact (`diagnosis`, `clearance`), so it does not travel on a diagnostics channel either.
 */
export interface AgentMemoryResolved {
  runId: string;
  /** How many scope tokens the resolver returned for this turn. */
  scopes: number;
  /** Memories in the block the model was shown. */
  offered: number;
  /** Applicable memories the `maxMemories` ceiling left out — non-zero means the block is partial. */
  omitted: number;
  /**
   * Of `omitted`, how many were ALWAYS-ON. The one to alert on: ordinary omission is the budget
   * working, while a dropped always-on memory is a deployment's own standing policies having stopped
   * reaching any prompt — more was pinned than the block holds.
   */
  pinnedOmitted: number;
  /**
   * Whether the block was selected by relevance to this turn rather than read whole. Distinguishes
   * "this deployment holds few memories" from "this turn drew twenty out of two thousand", which
   * `offered` alone reports identically.
   */
  recalled: boolean;
  /** Characters the memory block added to the system prompt. The WHOLE of what memory cost it. */
  promptChars: number;
}
/**
 * A turn writing one memory — the event an operator watches to see the agent's own write volume,
 * which is the risk surface memory has and retrieval does not. The scope token travels (it is what
 * says whose prompt just changed, and `run.started` already carries an actor id); the key and the
 * text do not.
 */
export interface AgentMemoryWritten {
  runId: string;
  scope: string;
  /** Length of the stored fact in characters — never the fact itself. */
  chars: number;
}
/**
 * A transient-classified tool error being retried in place (no new checkpoint) — see
 * `invokeWithTransientRetry`. Emitted once per retry (not for the final, non-retried outcome).
 */
export interface AgentToolRetry {
  toolName: string;
  toolCallId: string;
  /** 1-based ordinal of the attempt that just failed and is about to be retried. */
  attempt: number;
  /** The failed attempt's error message. */
  message: string;
}

// --- Span (trace) payloads — the START-phase payload of each traced operation. Metadata only:
// token counts / lengths / names, never prompt or output text (the point events' redaction
// posture). The traced result rides the `end`/`asyncEnd` envelope; see agent-loop's span helpers.

/** START payload of an `aviary:agent:llm.turn:*` span — one model call within a run. */
export interface AgentLlmTurnSpan {
  runId: string;
  /** Zero-based model-call index within the run (the loop's step counter). */
  step: number;
}
/** START payload of an `aviary:agent:tool.execution:*` span — one tool invocation. */
export interface AgentToolExecutionSpan {
  runId: string;
  toolCallId: string;
  toolName: string;
  toolType: 'read' | 'action';
}
/** START payload of an `aviary:agent:retrieval:*` span — inject-mode RAG retrieval. */
export interface AgentRetrievalSpan {
  runId: string;
  /** Length of the retrieval query in characters — never the query text itself. */
  queryLength: number;
  topK: number;
}
/** START payload of an `aviary:agent:follow-ups:*` span — the extra follow-up-suggestions call. */
export interface AgentFollowUpsSpan {
  runId: string;
  /** Zero-based model-call index of the final turn the follow-ups ride on. */
  step: number;
  /** How many follow-up questions were requested. */
  count: number;
}

/**
 * START payload of an `aviary:agent:structured-output:*` span — the formatting pass that restates a
 * finished answer as `AgentLoopDeps.outputSchema`. `attempt` is 0 for the pass itself and counts up
 * for each bounded repair, so a run that needed three tries is visible as three spans.
 */
export interface AgentStructuredOutputSpan {
  runId: string;
  /** Zero-based model-call index of the final turn whose answer is being restated. */
  step: number;
  attempt: number;
}

/** Declaration-merge so `emit('agent', ...)`, `trace('agent', ...)` and telescope infer the agent payloads. */
declare module '@dudousxd/nestjs-diagnostics' {
  interface ChannelRegistry {
    agent: {
      'run.started': AgentRunStarted;
      message: AgentMessageEvent;
      'tool-call': AgentToolCallEvent;
      'quota.exceeded': AgentQuotaExceeded;
      'run.finished': AgentRunFinished;
      'run.failed': AgentRunFailed;
      delegated: AgentDelegated;
      retrieved: AgentRetrieved;
      'skills.resolved': AgentSkillsResolved;
      'memory.resolved': AgentMemoryResolved;
      'memory.written': AgentMemoryWritten;
      'tool.retry': AgentToolRetry;
      // Span-only events (published via trace() on :start/:end/:asyncStart/:asyncEnd/:error
      // sub-channels, never as point events) — see AgentSpanEvent below.
      'llm.turn': AgentLlmTurnSpan;
      'tool.execution': AgentToolExecutionSpan;
      retrieval: AgentRetrievalSpan;
      'follow-ups': AgentFollowUpsSpan;
      'structured-output': AgentStructuredOutputSpan;
    };
  }
}

export function publishAgentRunStarted(payload: AgentRunStarted): void {
  emit('agent', 'run.started', payload);
}
export function publishAgentMessage(payload: AgentMessageEvent): void {
  emit('agent', 'message', payload);
}
export function publishAgentToolCall(payload: AgentToolCallEvent): void {
  emit('agent', 'tool-call', payload);
}
export function publishAgentQuotaExceeded(payload: AgentQuotaExceeded): void {
  emit('agent', 'quota.exceeded', payload);
}
export function publishAgentRunFinished(payload: AgentRunFinished): void {
  emit('agent', 'run.finished', payload);
}
export function publishAgentRunFailed(payload: AgentRunFailed): void {
  emit('agent', 'run.failed', payload);
}
export function publishAgentDelegated(payload: AgentDelegated): void {
  emit('agent', 'delegated', payload);
}
export function publishAgentRetrieved(payload: AgentRetrieved): void {
  emit('agent', 'retrieved', payload);
}
export function publishAgentToolRetry(payload: AgentToolRetry): void {
  emit('agent', 'tool.retry', payload);
}
export function publishAgentSkillsResolved(payload: AgentSkillsResolved): void {
  emit('agent', 'skills.resolved', payload);
}
export function publishAgentMemoryResolved(payload: AgentMemoryResolved): void {
  emit('agent', 'memory.resolved', payload);
}
export function publishAgentMemoryWritten(payload: AgentMemoryWritten): void {
  emit('agent', 'memory.written', payload);
}

/**
 * Events published ONLY as spans — via `trace('agent', ...)` on the five `:start`/`:end`/
 * `:asyncStart`/`:asyncEnd`/`:error` sub-channels — never as point events on the base channel.
 * They are deliberately NOT in {@link AGENT_DIAGNOSTIC_EVENTS}: the point-event watcher has
 * nothing to subscribe to on their base channels, and claiming their keys would be meaningless
 * (the generic bridge only records point traffic).
 */
export type AgentSpanEvent =
  | 'llm.turn'
  | 'tool.execution'
  | 'retrieval'
  | 'follow-ups'
  | 'structured-output';

/** All span-only events, in a stable order — for a future span recorder to derive sub-channels from. */
export const AGENT_SPAN_EVENTS: readonly AgentSpanEvent[] = [
  'llm.turn',
  'tool.execution',
  'retrieval',
  'follow-ups',
];

/** Compile-time-only check: every span event must be declared on `ChannelRegistry['agent']`. */
type AgentSpanEventsAreRegistered = [AgentSpanEvent] extends [keyof ChannelRegistry['agent']]
  ? true
  : ["AGENT_SPAN_EVENTS names an event not declared on ChannelRegistry['agent']"];
const agentSpanEventsAreRegistered: AgentSpanEventsAreRegistered = true;
void agentSpanEventsAreRegistered;

/** Every POINT event key declared on `ChannelRegistry['agent']` above — derived, not hand-copied. */
export type AgentDiagnosticEvent = Exclude<keyof ChannelRegistry['agent'], AgentSpanEvent>;

/**
 * All 12 point events on `ChannelRegistry['agent']`, in a stable order — handy for wiring
 * subscribers (mirrors nestjs-media's `MEDIA_DIAGNOSTIC_EVENTS`). Span-only events (see
 * {@link AgentSpanEvent}) are excluded. A drift between this list and the registry is a compile
 * error in both directions: an extra/misspelled entry fails this array's own
 * `readonly AgentDiagnosticEvent[]` annotation immediately; a missing entry fails the
 * {@link AgentDiagnosticEventsCoverAllKeys} check below.
 */
export const AGENT_DIAGNOSTIC_EVENTS: readonly AgentDiagnosticEvent[] = [
  'run.started',
  'message',
  'tool-call',
  'quota.exceeded',
  'run.finished',
  'run.failed',
  'delegated',
  'retrieved',
  'skills.resolved',
  'memory.resolved',
  'memory.written',
  'tool.retry',
];

/** Compile-time-only check: every point event of `ChannelRegistry['agent']` must appear above. */
type AgentDiagnosticEventsCoverAllKeys = [AgentDiagnosticEvent] extends [
  (typeof AGENT_DIAGNOSTIC_EVENTS)[number],
]
  ? true
  : ["AGENT_DIAGNOSTIC_EVENTS is missing a key declared on ChannelRegistry['agent']"];

// If this line stops typechecking, an event was added to (or renamed on) ChannelRegistry['agent']
// without a matching update to AGENT_DIAGNOSTIC_EVENTS (point events) or AgentSpanEvent (spans).
const agentDiagnosticEventsCoverAllKeys: AgentDiagnosticEventsCoverAllKeys = true;
void agentDiagnosticEventsCoverAllKeys;

/**
 * The telescope key for an agent diagnostics channel — `agent:<event>`. This is the key the
 * `@dudousxd/nestjs-diagnostics-telescope` generic bridge matches its `exclude` option against,
 * and the label its "Busiest events" panel shows. Distinct from the `aviary:agent:<event>` channel
 * name used on the wire. Mirrors `mediaDiagnosticKey`.
 */
export type AgentDiagnosticKey = `agent:${AgentDiagnosticEvent}`;

/**
 * Compose the telescope key for an agent event, typed against {@link AgentDiagnosticEvent} so a
 * misspelled event is a compile error. Feed the result to `nestjsDiagnosticsTelescope({ exclude:
 * [...] })` to mute a noisy channel, e.g. `agentDiagnosticKey('message')`.
 */
export function agentDiagnosticKey(event: AgentDiagnosticEvent): AgentDiagnosticKey {
  return `agent:${event}`;
}
