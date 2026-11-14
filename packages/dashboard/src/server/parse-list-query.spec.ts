import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  parseApprovalsQuery,
  parseRunsQuery,
  parseThreadsQuery,
  parseToolCallsQuery,
  parseTopSize,
  toListPage,
} from './parse-list-query.js';

describe('paging', () => {
  it('defaults to page 1, size 25 and no filter', () => {
    expect(parseRunsQuery({})).toEqual({ page: 1, pageSize: 25 });
  });

  it('reads page and size, clamping size to 200', () => {
    expect(parseRunsQuery({ page: '3', size: '9999' })).toEqual({ page: 3, pageSize: 200 });
  });

  it('400s on a junk, zero or negative page or size', () => {
    expect(() => parseRunsQuery({ page: 'abc' })).toThrow(BadRequestException);
    expect(() => parseRunsQuery({ page: '0' })).toThrow(BadRequestException);
    expect(() => parseRunsQuery({ size: '-5' })).toThrow(BadRequestException);
  });

  it('ignores the removed limit param rather than aliasing it', () => {
    expect(parseRunsQuery({ limit: '5' })).toEqual({ page: 1, pageSize: 25 });
  });
});

describe('sort', () => {
  it('accepts each list fixed order', () => {
    expect(parseRunsQuery({ sort: '-startedAt' }).page).toBe(1);
    expect(parseToolCallsQuery({ sort: '-createdAt' }).page).toBe(1);
    expect(parseThreadsQuery({ sort: '-lastActivityAt' }).page).toBe(1);
    expect(parseApprovalsQuery({ sort: 'requestedAt' }).page).toBe(1);
  });

  it('400s on another field, the reverse direction, or extra keys', () => {
    expect(() => parseRunsQuery({ sort: 'agentName' })).toThrow(/Unknown sort field "agentName"/);
    expect(() => parseRunsQuery({ sort: 'startedAt' })).toThrow(/always sorted by "-startedAt"/);
    expect(() => parseApprovalsQuery({ sort: '-requestedAt' })).toThrow(BadRequestException);
    expect(() => parseRunsQuery({ sort: '-startedAt,-startedAt' })).toThrow(BadRequestException);
  });
});

describe('parseToolCallsQuery', () => {
  it('maps known filters through (nested and flat query forms)', () => {
    expect(parseToolCallsQuery({ filter: { toolName: 'search', status: 'ok' } }).where).toEqual({
      toolName: 'search',
      status: 'ok',
    });
    expect(parseToolCallsQuery({ 'filter[threadId]': 'th1' }).where).toEqual({ threadId: 'th1' });
  });

  it('accepts valid YYYY-MM-DD day bounds', () => {
    expect(
      parseToolCallsQuery({ filter: { fromDay: '2026-07-01', toDay: '2026-07-05' } }).where,
    ).toEqual({ fromDay: '2026-07-01', toDay: '2026-07-05' });
  });

  it('400s on an unknown filter field, naming it', () => {
    expect(() => parseToolCallsQuery({ filter: { bogus: 'x' } })).toThrow(BadRequestException);
    expect(() => parseToolCallsQuery({ filter: { bogus: 'x' } })).toThrow(/"bogus"/);
  });

  it('400s on an operator the field does not support, or a list', () => {
    expect(() => parseToolCallsQuery({ filter: { status: { ne: 'ok' } } })).toThrow(
      BadRequestException,
    );
    expect(() => parseToolCallsQuery({ filter: { status: 'ok,failed' } })).toThrow(
      BadRequestException,
    );
  });

  it('400s on a malformed day bound', () => {
    expect(() => parseToolCallsQuery({ filter: { fromDay: '07/01/2026' } })).toThrow(
      /must be YYYY-MM-DD/,
    );
  });

  it('does not read the removed where[...] form', () => {
    expect(parseToolCallsQuery({ where: { status: 'ok' } })).toEqual({ page: 1, pageSize: 25 });
  });
});

describe('parseThreadsQuery', () => {
  it('maps title as a contains filter and actorRef as equality', () => {
    expect(
      parseThreadsQuery({ filter: { title: { contains: 'procurement' }, actorRef: 'user:1' } })
        .where,
    ).toEqual({ title: 'procurement', actorRef: 'user:1' });
  });

  it('keeps a comma inside a title search as text', () => {
    expect(parseThreadsQuery({ filter: { title: { contains: 'a,b' } } }).where).toEqual({
      title: 'a,b',
    });
  });

  it('400s on a bare title (equality is not what it does)', () => {
    expect(() => parseThreadsQuery({ filter: { title: 'x' } })).toThrow(/Supported: contains/);
  });

  it('400s on an unknown filter field', () => {
    expect(() => parseThreadsQuery({ filter: { status: 'ok' } })).toThrow(BadRequestException);
  });

  it('400s on a malformed day bound', () => {
    expect(() => parseThreadsQuery({ filter: { toDay: 'not-a-day' } })).toThrow(
      BadRequestException,
    );
  });
});

describe('parseRunsQuery', () => {
  it('maps known filters through, threadId included', () => {
    expect(
      parseRunsQuery({ filter: { status: 'failed', agentName: 'analyst', threadId: 'th1' } }).where,
    ).toEqual({ status: 'failed', agentName: 'analyst', threadId: 'th1' });
  });

  it('skips an empty filter value, so a cleared input sends no condition', () => {
    expect(parseRunsQuery({ filter: { status: '' } })).toEqual({ page: 1, pageSize: 25 });
  });

  it('400s on an unknown filter field', () => {
    expect(() => parseRunsQuery({ filter: { nonsense: 'x' } })).toThrow(BadRequestException);
  });
});

describe('parseApprovalsQuery', () => {
  it('maps every known filter through', () => {
    const filter = {
      toolName: 'deploy',
      threadId: 'th1',
      actorRef: 'ops',
      agentName: 'ops-agent',
      fromDay: '2026-08-01',
      toDay: '2026-08-03',
    };
    expect(parseApprovalsQuery({ filter }).where).toEqual(filter);
  });

  it('400s on an unknown filter field, naming it', () => {
    expect(() => parseApprovalsQuery({ filter: { status: 'pending_approval' } })).toThrow(
      /unknown field "status"/,
    );
  });
});

describe('toListPage', () => {
  it('wraps a governance page in { data, meta }', () => {
    expect(toListPage({ rows: ['a', 'b'], total: 51, page: 2, pageSize: 25 })).toEqual({
      data: ['a', 'b'],
      meta: { total: 51, perPage: 25, currentPage: 2, lastPage: 3, firstPage: 1 },
    });
  });
});

describe('parseTopSize', () => {
  it('defaults, clamps to 200 and 400s on junk', () => {
    expect(parseTopSize({}, 10)).toBe(10);
    expect(parseTopSize({ size: '5' }, 10)).toBe(5);
    expect(parseTopSize({ size: '9999' }, 10)).toBe(200);
    expect(() => parseTopSize({ size: 'x' }, 10)).toThrow(BadRequestException);
  });
});
