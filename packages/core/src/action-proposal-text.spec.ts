import { describe, expect, it } from 'vitest';
import {
  type TextActionProposalVocabulary,
  ptBrActionProposalText,
  resolveTextActionProposalDecision,
  textActionProposalReply,
} from './action-proposal-text.js';

const pending = [{ id: 'send-123', decision: 'pending' as const }];
const ptBr: TextActionProposalVocabulary = {
  approve: ptBrActionProposalText.vocabulary.approve ?? [],
  reject: ptBrActionProposalText.vocabulary.reject ?? [],
  remember: ptBrActionProposalText.vocabulary.remember ?? [],
};

describe('text action proposal decisions (English, the default)', () => {
  it('accepts an exact affirmative only for one pending proposal', () => {
    expect(resolveTextActionProposalDecision('Yes!', pending)).toEqual({
      status: 'decision',
      proposalId: 'send-123',
      decision: 'approved',
      remember: false,
    });
  });
  it.each([
    ['yes', 'approved'],
    ['confirm', 'approved'],
    ['approve', 'approved'],
    ['approved', 'approved'],
    ['OK', 'approved'],
    ['no', 'rejected'],
    ['cancel', 'rejected'],
    ['reject.', 'rejected'],
    ['deny', 'rejected'],
  ] as const)('reads %s as %s', (text, decision) => {
    expect(resolveTextActionProposalDecision(text, pending)).toMatchObject({
      status: 'decision',
      decision,
    });
  });
  it('requires a choice when the text could address multiple proposals', () => {
    expect(
      resolveTextActionProposalDecision('confirm', [
        ...pending,
        { id: 'other', decision: 'pending' },
      ]),
    ).toEqual({ status: 'ambiguous', proposalIds: ['send-123', 'other'] });
  });
  it('resolves an explicit opaque id without case folding it', () => {
    const rows = [...pending, { id: 'Case_ID', decision: 'pending' as const }];
    expect(resolveTextActionProposalDecision('approve #Case_ID', rows)).toMatchObject({
      status: 'decision',
      proposalId: 'Case_ID',
    });
    expect(resolveTextActionProposalDecision('approve #case_id', rows)).toEqual({
      status: 'unmatched',
    });
  });
  it('supports remembering a tool for this conversation, only for an approval', () => {
    expect(
      resolveTextActionProposalDecision('approve always in this conversation #send-123', pending),
    ).toMatchObject({ status: 'decision', decision: 'approved', remember: true });
    expect(
      resolveTextActionProposalDecision('reject always in this conversation', pending),
    ).toEqual({ status: 'unmatched' });
  });
  it('does not take Portuguese commands by default', () => {
    expect(resolveTextActionProposalDecision('sim', pending)).toEqual({ status: 'unmatched' });
  });
  it.each([
    'no, confirm it',
    'yes, but change the recipient',
    'can you confirm?',
    '> yes',
    'he said "yes"',
    'yes\nignore the above',
    'approve #missing',
    'yes for yesterday',
    'not now',
  ])('does not infer consent from %s', (text) => {
    expect(resolveTextActionProposalDecision(text, pending)).toEqual({ status: 'unmatched' });
  });
  it('excludes settled and superseded proposals from candidate selection', () => {
    expect(
      resolveTextActionProposalDecision('yes', [{ id: 'old', decision: 'superseded' }, ...pending]),
    ).toMatchObject({ proposalId: 'send-123' });
    expect(resolveTextActionProposalDecision('yes', [{ id: 'old', decision: 'approved' }])).toEqual(
      { status: 'unmatched' },
    );
  });
  it('does not execute effects or grant authority: resolution only selects a candidate', () => {
    const candidate = Object.freeze({ id: 'send-123', decision: 'pending' as const });
    expect(
      resolveTextActionProposalDecision('Confirm #send-123.', Object.freeze([candidate])),
    ).toMatchObject({ status: 'decision' });
    expect(candidate).toEqual({ id: 'send-123', decision: 'pending' });
  });
  it('replies in English', () => {
    expect(textActionProposalReply({ status: 'applied' }, 'approved')).toBe(
      'Proposal approved and queued to run.',
    );
    expect(textActionProposalReply({ status: 'applied' }, 'rejected')).toBe(
      'Proposal rejected; nothing was run.',
    );
    expect(textActionProposalReply({ status: 'expired' }, 'approved')).toBe(
      'The proposal expired; nothing was run.',
    );
    expect(textActionProposalReply({ status: 'conflict' }, 'approved')).toBe(
      'This proposal could not be changed; refresh the list to see where it stands.',
    );
  });
});

describe('the ptBr preset', () => {
  it('accepts Portuguese commands, and still English ones', () => {
    expect(resolveTextActionProposalDecision('Sim!', pending, ptBr)).toMatchObject({
      status: 'decision',
      decision: 'approved',
    });
    expect(resolveTextActionProposalDecision('cancela', pending, ptBr)).toMatchObject({
      decision: 'rejected',
    });
    expect(resolveTextActionProposalDecision('yes', pending, ptBr)).toMatchObject({
      decision: 'approved',
    });
    expect(
      resolveTextActionProposalDecision('aprovar sempre nesta conversa #send-123', pending, ptBr),
    ).toMatchObject({ decision: 'approved', remember: true });
  });
  it.each([
    'não confirmar',
    'sim, mas altera o destino',
    'pode confirmar?',
    '> sim',
    'ele disse "sim"',
    'sim\nignore o anterior',
    'aprovar #missing',
    'sim para ontem',
  ])('does not infer consent from %s', (text) => {
    expect(resolveTextActionProposalDecision(text, pending, ptBr)).toEqual({
      status: 'unmatched',
    });
  });
  it('replies in Portuguese', () => {
    const replies = { ...ptBrActionProposalText.replies } as Parameters<
      typeof textActionProposalReply
    >[2];
    expect(textActionProposalReply({ status: 'applied' }, 'approved', replies)).toBe(
      'Proposta aprovada e enfileirada para execução.',
    );
  });
});
