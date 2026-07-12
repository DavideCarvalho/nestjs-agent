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
}
export interface AgentRetrieved {
  runId: string;
  query: string;
  /** How many passages the retriever returned. */
  count: number;
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
      // Span-only events (published via trace() on :start/:end/:asyncStart/:asyncEnd/:error
      // sub-channels, never as point events) — see AgentSpanEvent below.
      'llm.turn': AgentLlmTurnSpan;
      'tool.execution': AgentToolExecutionSpan;
      retrieval: AgentRetrievalSpan;
      'follow-ups': AgentFollowUpsSpan;
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

/**
 * Events published ONLY as spans — via `trace('agent', ...)` on the five `:start`/`:end`/
 * `:asyncStart`/`:asyncEnd`/`:error` sub-channels — never as point events on the base channel.
 * They are deliberately NOT in {@link AGENT_DIAGNOSTIC_EVENTS}: the point-event watcher has
 * nothing to subscribe to on their base channels, and claiming their keys would be meaningless
 * (the generic bridge only records point traffic).
 */
export type AgentSpanEvent = 'llm.turn' | 'tool.execution' | 'retrieval' | 'follow-ups';

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
 * All 8 point events on `ChannelRegistry['agent']`, in a stable order — handy for wiring
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
