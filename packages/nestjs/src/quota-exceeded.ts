import {
  type Actor,
  type AgentQuotaExceeded,
  type QuotaBlock,
  type QuotaReport,
  publishAgentQuotaExceeded,
} from '@dudousxd/nestjs-agent-core';

/**
 * Publish `aviary:agent:quota.exceeded` for a turn refused on `report.blocked`, with the exhausted
 * window's figures — what the dashboard's live feed and Telescope read. Whoever refuses the turn
 * calls this: the send gate and the message queue.
 */
export function publishQuotaBlocked(actor: Actor, report: QuotaReport, blocked: QuotaBlock): void {
  const window = report.windows.find((candidate) => candidate.period === blocked.period);
  const payload: AgentQuotaExceeded = {
    actorId: actor.id,
    period: blocked.period,
    ...(blocked.reason !== undefined ? { reason: blocked.reason } : {}),
    ...(window?.usedTokens !== undefined ? { usedTokens: window.usedTokens } : {}),
    ...(window?.limitTokens !== undefined ? { limitTokens: window.limitTokens } : {}),
    ...(window !== undefined ? { usedUsd: window.usedUsd } : {}),
    ...(window?.limitUsd !== undefined ? { limitUsd: window.limitUsd } : {}),
  };
  publishAgentQuotaExceeded(payload);
}
