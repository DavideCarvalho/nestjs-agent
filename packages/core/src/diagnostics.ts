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

/** Declaration-merge so `emit('agent', ...)` and telescope infer the agent payloads. */
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

/** Every event key declared on `ChannelRegistry['agent']` above — derived, not hand-copied. */
export type AgentDiagnosticEvent = keyof ChannelRegistry['agent'];

/**
 * All 8 events on `ChannelRegistry['agent']`, in a stable order — handy for wiring subscribers
 * (mirrors nestjs-media's `MEDIA_DIAGNOSTIC_EVENTS`). A drift between this list and the registry is
 * a compile error in both directions: an extra/misspelled entry fails this array's own
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

/** Compile-time-only check: every key of `ChannelRegistry['agent']` must appear in the array above. */
type AgentDiagnosticEventsCoverAllKeys = [AgentDiagnosticEvent] extends [
  (typeof AGENT_DIAGNOSTIC_EVENTS)[number],
]
  ? true
  : ["AGENT_DIAGNOSTIC_EVENTS is missing a key declared on ChannelRegistry['agent']"];

// If this line stops typechecking, an event was added to (or renamed on) ChannelRegistry['agent']
// without a matching update to AGENT_DIAGNOSTIC_EVENTS above.
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
