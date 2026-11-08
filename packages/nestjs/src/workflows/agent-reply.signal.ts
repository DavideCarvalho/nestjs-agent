import type { HumanReply } from '@dudousxd/nestjs-agent-core';
import { WorkflowSignal } from '@nestjs/workflows';

/**
 * A person's reply to a call a turn is parked on: a `Decision` on an action tool, or the answers to
 * a question set. Keyed by {@link replyKey}, so a reply reaches only the call it answers.
 */
export const AGENT_REPLY = new WorkflowSignal<HumanReply>('aviary.agent.reply');

/** The key a reply to call `toolCallId` of run `runId` is sent and awaited under. */
export function replyKey(runId: string, toolCallId: string): string {
  return `${runId}:${toolCallId}`;
}

/** A call waiting for a person, as `WorkflowsAgentRunner.pendingReplies()` lists it. */
export interface PendingReply {
  /** What the reply is signalled under ({@link replyKey}). */
  key: string;
  /** The turn's run id. */
  runId: string;
  toolCallId: string;
  /** The tool, or `'ask'` / `'intake'` for a question set. */
  toolName: string;
  kind: 'approval' | 'elicitation';
}
