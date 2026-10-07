import type { ActionProposalDecision } from './spi/action-proposal-store.js';

export interface TextActionProposalCandidate {
  id: string;
  decision: ActionProposalDecision;
}
export type TextActionProposalResolution =
  | { status: 'unmatched' }
  | { status: 'ambiguous'; proposalIds: string[] }
  | {
      status: 'decision';
      proposalId: string;
      decision: 'approved' | 'rejected';
      remember: boolean;
    };

/**
 * Recognizes complete, explicit decision messages. This grants no authority: callers must
 * resolve the authenticated actor and use the normal scoped decision service with via=text.
 * Never feed model output here or consume an unmatched message as an approval.
 */
export function resolveTextActionProposalDecision(
  text: string,
  proposals: readonly TextActionProposalCandidate[],
): TextActionProposalResolution {
  const command = parseTextActionProposalCommand(text);
  if (command.status === 'unmatched') return command;
  const { decision, remember } = command;
  const pending = proposals.filter((proposal) => proposal.decision === 'pending');
  const explicitId = command.proposalId;
  if (explicitId !== undefined) {
    if (!pending.some((proposal) => proposal.id === explicitId)) return { status: 'unmatched' };
    return { status: 'decision', proposalId: explicitId, decision, remember };
  }
  if (pending.length === 0) return { status: 'unmatched' };
  if (pending.length > 1) return { status: 'ambiguous', proposalIds: pending.map(({ id }) => id) };
  const candidate = pending[0];
  if (!candidate) return { status: 'unmatched' };
  return { status: 'decision', proposalId: candidate.id, decision, remember };
}

export type TextActionProposalCommand =
  | { status: 'unmatched' }
  | {
      status: 'command';
      decision: 'approved' | 'rejected';
      remember: boolean;
      proposalId?: string;
    };
/** Whole-message verbs that approve — Portuguese, then English. */
const APPROVE_VERBS = [
  'sim',
  'confirmo',
  'confirmar',
  'aprovar',
  'aprovo',
  'yes',
  'confirm',
  'approve',
];
/** Whole-message verbs that reject — Portuguese, then English. */
const REJECT_VERBS = ['cancelar', 'rejeitar', 'rejeito', 'não', 'nao', 'no', 'cancel', 'reject'];
/** The suffix that asks to remember an approval for the rest of the conversation. */
const REMEMBER_PHRASES = ['sempre nesta conversa', 'always in this conversation'];

const COMMAND = new RegExp(
  `^(${[...APPROVE_VERBS, ...REJECT_VERBS].join('|')})(?: (${REMEMBER_PHRASES.join('|')}))?(?: #([^\\s]+?))?[.!]?$`,
  'iu',
);

/**
 * Parse exact consent syntax only. Authentication and target lookup remain the caller's
 * responsibility. Portuguese and English commands are both recognized (`sim`/`yes`,
 * `aprovar`/`approve`, `confirmar`/`confirm`, `não`/`no`, `rejeitar`/`reject`, `cancelar`/`cancel`),
 * each optionally followed by `sempre nesta conversa` / `always in this conversation` and `#ID`.
 */
export function parseTextActionProposalCommand(text: string): TextActionProposalCommand {
  if (/[\r\n]/u.test(text)) return { status: 'unmatched' };
  const normalized = text.trim();
  const match = COMMAND.exec(normalized);
  if (!match) return { status: 'unmatched' };
  const verb = match[1]?.toLocaleLowerCase('pt-BR');
  if (verb === undefined) return { status: 'unmatched' };
  const decision = REJECT_VERBS.includes(verb) ? 'rejected' : 'approved';
  const remember = match[2] !== undefined;
  if (remember && decision !== 'approved') return { status: 'unmatched' };
  return {
    status: 'command',
    decision,
    remember,
    ...(match[3] !== undefined ? { proposalId: match[3] } : {}),
  };
}
