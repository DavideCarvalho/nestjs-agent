import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  parseApprovalWhere,
  parsePageNumber,
  parseRunWhere,
  parseThreadWhere,
  parseToolCallWhere,
} from './parse-page-query.js';

describe('parsePageNumber', () => {
  it('defaults to 1 when absent', () => {
    expect(parsePageNumber(undefined)).toBe(1);
  });

  it('defaults to 1 for non-numeric, zero, or negative junk', () => {
    expect(parsePageNumber('abc')).toBe(1);
    expect(parsePageNumber('0')).toBe(1);
    expect(parsePageNumber('-5')).toBe(1);
  });

  it('parses a valid positive page number', () => {
    expect(parsePageNumber('3')).toBe(3);
  });
});

describe('parseToolCallWhere', () => {
  it('returns undefined when no where params are given', () => {
    expect(parseToolCallWhere(undefined)).toBeUndefined();
    expect(parseToolCallWhere({})).toBeUndefined();
  });

  it('maps known fields through', () => {
    expect(parseToolCallWhere({ toolName: 'search', status: 'ok' })).toEqual({
      toolName: 'search',
      status: 'ok',
    });
  });

  it('accepts valid YYYY-MM-DD day bounds', () => {
    expect(parseToolCallWhere({ fromDay: '2026-07-01', toDay: '2026-07-05' })).toEqual({
      fromDay: '2026-07-01',
      toDay: '2026-07-05',
    });
  });

  it('400s on an unknown where field, naming it', () => {
    expect(() => parseToolCallWhere({ bogus: 'x' })).toThrow(BadRequestException);
    expect(() => parseToolCallWhere({ bogus: 'x' })).toThrow(/"bogus"/);
  });

  it('400s on a malformed day bound', () => {
    expect(() => parseToolCallWhere({ fromDay: '07/01/2026' })).toThrow(BadRequestException);
  });
});

describe('parseThreadWhere', () => {
  it('returns undefined when no where params are given', () => {
    expect(parseThreadWhere(undefined)).toBeUndefined();
  });

  it('maps known fields through, including title substring search', () => {
    expect(parseThreadWhere({ title: 'procurement', actorRef: 'user:1' })).toEqual({
      title: 'procurement',
      actorRef: 'user:1',
    });
  });

  it('400s on an unknown where field', () => {
    expect(() => parseThreadWhere({ status: 'ok' })).toThrow(BadRequestException);
  });

  it('400s on a malformed day bound', () => {
    expect(() => parseThreadWhere({ toDay: 'not-a-day' })).toThrow(BadRequestException);
  });
});

describe('parseRunWhere', () => {
  it('returns undefined when no where params are given', () => {
    expect(parseRunWhere(undefined)).toBeUndefined();
  });

  it('maps known fields through', () => {
    expect(parseRunWhere({ status: 'failed', agentName: 'analyst' })).toEqual({
      status: 'failed',
      agentName: 'analyst',
    });
  });

  it('accepts threadId — every adapter supported it, only this parser rejected it', () => {
    expect(parseRunWhere({ threadId: 'th1' })).toEqual({ threadId: 'th1' });
  });

  it('400s on an unknown where field', () => {
    expect(() => parseRunWhere({ nonsense: 'x' })).toThrow(BadRequestException);
  });

  it('400s on a malformed day bound', () => {
    expect(() => parseRunWhere({ fromDay: '2026-7-1' })).toThrow(BadRequestException);
  });
});

describe('parseApprovalWhere', () => {
  it('returns undefined when no where params are given', () => {
    expect(parseApprovalWhere(undefined)).toBeUndefined();
    expect(parseApprovalWhere({})).toBeUndefined();
  });

  it('maps every known field through', () => {
    expect(
      parseApprovalWhere({
        toolName: 'deploy',
        threadId: 'th1',
        actorRef: 'ops',
        agentName: 'ops-agent',
        fromDay: '2026-08-01',
        toDay: '2026-08-03',
      }),
    ).toEqual({
      toolName: 'deploy',
      threadId: 'th1',
      actorRef: 'ops',
      agentName: 'ops-agent',
      fromDay: '2026-08-01',
      toDay: '2026-08-03',
    });
  });

  it('400s on an unknown where field, naming it', () => {
    expect(() => parseApprovalWhere({ status: 'pending_approval' })).toThrow(BadRequestException);
    expect(() => parseApprovalWhere({ status: 'pending_approval' })).toThrow(
      /Unknown where field "status"/,
    );
  });

  it('400s on a malformed day bound', () => {
    expect(() => parseApprovalWhere({ fromDay: '2026-8-1' })).toThrow(BadRequestException);
  });
});
