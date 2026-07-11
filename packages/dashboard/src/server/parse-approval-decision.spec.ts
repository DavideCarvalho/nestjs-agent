import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { parseApprovalDecision } from './parse-approval-decision';

describe('parseApprovalDecision', () => {
  it('accepts an approve body with no reason', () => {
    expect(parseApprovalDecision({ approved: true })).toEqual({ approved: true });
  });

  it('carries through an optional reason when present', () => {
    expect(parseApprovalDecision({ approved: false, reason: 'not now' })).toEqual({
      approved: false,
      reason: 'not now',
    });
  });

  it('rejects a non-object body', () => {
    expect(() => parseApprovalDecision(null)).toThrow(BadRequestException);
    expect(() => parseApprovalDecision('yes')).toThrow(BadRequestException);
    expect(() => parseApprovalDecision(undefined)).toThrow(BadRequestException);
  });

  it('rejects a missing or non-boolean approved', () => {
    expect(() => parseApprovalDecision({})).toThrow(BadRequestException);
    expect(() => parseApprovalDecision({ approved: 'true' })).toThrow(BadRequestException);
  });

  it('rejects a non-string reason', () => {
    expect(() => parseApprovalDecision({ approved: false, reason: 42 })).toThrow(
      BadRequestException,
    );
  });
});
