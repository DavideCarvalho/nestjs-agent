/**
 * Console-side HITL decisions. Implemented by the agent runtime (the nestjs package binds it to
 * the same signal path chat approvals use); the dashboard injects it OPTIONALLY — absent = the
 * approvals inbox renders read-only.
 */
export interface AgentApprovalPort {
  /**
   * `remember` approves later calls of the same tool in the same thread; `decidedVia` names the
   * surface the decision came through (`'console'`, `'slack'`, …) and is persisted with the call.
   */
  approve(
    toolCallId: string,
    opts?: { executedByRef?: string; remember?: boolean; decidedVia?: string },
  ): Promise<void>;
  reject(
    toolCallId: string,
    opts?: { executedByRef?: string; reason?: string; decidedVia?: string },
  ): Promise<void>;
}
