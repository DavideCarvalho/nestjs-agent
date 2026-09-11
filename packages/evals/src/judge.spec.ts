import { describe, expect, it } from 'vitest';
import { JudgeVerdictError, discardingSink, parseJudgeVerdict } from './judge.js';

describe('parseJudgeVerdict', () => {
  it('normalizes the 0-5 band onto 0..1 and keeps the raw band in metadata', () => {
    expect(parseJudgeVerdict('SCORE: 3\nREASON: partly relevant.')).toEqual({
      score: 0.6,
      reason: 'partly relevant.',
      metadata: { rawScore: 3, maxScore: 5 },
    });
  });

  it('accepts a fractional score and a lower-case label', () => {
    expect(parseJudgeVerdict('score: 2.5\nreason: half right.').score).toBe(0.5);
  });

  it('tolerates a missing reason — the number is the verdict', () => {
    expect(parseJudgeVerdict('SCORE: 5').reason).toBe('the judge gave no reason');
  });

  it('throws on a reply with no score rather than reading it as 0', () => {
    expect(() => parseJudgeVerdict('It was fine.')).toThrow(JudgeVerdictError);
  });

  it('throws when the judge scores off the scale it was given', () => {
    expect(() => parseJudgeVerdict('SCORE: 9\nREASON: excellent.')).toThrow(
      /outside the 0-5 scale/,
    );
  });
});

describe('discardingSink', () => {
  it('accepts writes, end and fail without throwing — a judge call has no stream to join', () => {
    const sink = discardingSink();

    expect(() => {
      sink.write(new TextEncoder().encode('token'));
      sink.end();
      sink.fail({ code: 'nope', message: 'nope' });
    }).not.toThrow();
  });
});
