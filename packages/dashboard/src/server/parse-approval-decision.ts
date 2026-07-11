import { BadRequestException } from '@nestjs/common';

/** The parsed, minimally-validated `POST <api>/approvals/:toolCallId` body. */
export interface ApprovalDecisionInput {
  approved: boolean;
  reason?: string;
}

/**
 * Minimal shape guard for a `POST <api>/approvals/:toolCallId` body — rejects junk before it reaches
 * `AgentApprovalPort.approve`/`reject`. Mirrors `parsePriceInput`'s role for the pricing endpoint.
 */
export function parseApprovalDecision(body: unknown): ApprovalDecisionInput {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestException('Expected a JSON object body.');
  }
  const { approved, reason } = body as Record<string, unknown>;

  if (typeof approved !== 'boolean') {
    throw new BadRequestException('"approved" must be a boolean.');
  }
  if (reason !== undefined && typeof reason !== 'string') {
    throw new BadRequestException('"reason" must be a string when present.');
  }

  return { approved, ...(reason !== undefined ? { reason } : {}) };
}
