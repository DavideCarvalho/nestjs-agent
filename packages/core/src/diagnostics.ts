import { emit } from '@dudousxd/nestjs-diagnostics';

/** Payloads carried on each `aviary:agent:*` channel. */
export interface AgentRunStarted {
  runId: string;
  threadId: string;
  actorId: string;
  persona?: string;
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

/** Declaration-merge so `emit('agent', ...)` and telescope infer the agent payloads. */
declare module '@dudousxd/nestjs-diagnostics' {
  interface ChannelRegistry {
    agent: {
      'run.started': AgentRunStarted;
      message: AgentMessageEvent;
      'tool-call': AgentToolCallEvent;
      'quota.exceeded': AgentQuotaExceeded;
      'run.finished': AgentRunFinished;
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
