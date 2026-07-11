/**
 * Console-side HITL decisions. Implemented by the agent runtime (the nestjs package binds it to
 * the same signal path chat approvals use); the dashboard injects it OPTIONALLY — absent = the
 * approvals inbox renders read-only.
 */
export interface AgentApprovalPort {
  approve(toolCallId: string, opts?: { executedByRef?: string }): Promise<void>;
  reject(toolCallId: string, opts?: { executedByRef?: string; reason?: string }): Promise<void>;
}
