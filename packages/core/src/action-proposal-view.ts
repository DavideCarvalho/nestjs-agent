import type { ActionProposalOutcomeDelivery } from './spi/action-proposal-outcome-store.js';
import type {
  ActionProposal,
  ActionProposalExecution,
  ActionProposalMutationResult,
} from './spi/action-proposal-store.js';

/**
 * What leaves the server about a proposal — the routes, a text decision's answer, AG-UI, the approval
 * port. The stored row minus what only the worker and the store may hold: the execution and
 * delivery leases (whose token lets a holder settle the work), the idempotency key the tool's side
 * effect is keyed on, and the execution address (the original preparation input and the request's
 * context).
 */
export interface ActionProposalView
  extends Omit<
    ActionProposal,
    'execution' | 'outcomeDelivery' | 'idempotencyKey' | 'preparationInput' | 'executionContext'
  > {
  execution: Omit<ActionProposalExecution, 'lease'> | null;
  outcomeDelivery?: Omit<ActionProposalOutcomeDelivery, 'lease'>;
}

/** {@link ActionProposalMutationResult} with its proposal as an {@link ActionProposalView}. */
export interface ActionProposalMutationView extends Omit<ActionProposalMutationResult, 'proposal'> {
  proposal?: ActionProposalView;
}

/** The public view of a stored proposal. See {@link ActionProposalView}. */
export function toActionProposalView(proposal: ActionProposal): ActionProposalView {
  const {
    execution,
    outcomeDelivery,
    idempotencyKey: _idempotencyKey,
    preparationInput: _preparationInput,
    executionContext: _executionContext,
    ...rest
  } = proposal;
  return {
    ...rest,
    execution: execution === null ? null : withoutLease(execution),
    ...(outcomeDelivery !== undefined ? { outcomeDelivery: withoutLease(outcomeDelivery) } : {}),
  };
}

/** The public view of a mutation's answer. See {@link ActionProposalView}. */
export function toActionProposalMutationView(
  result: ActionProposalMutationResult,
): ActionProposalMutationView {
  const { proposal, ...rest } = result;
  return {
    ...rest,
    ...(proposal !== undefined ? { proposal: toActionProposalView(proposal) } : {}),
  };
}

function withoutLease<T extends { lease: unknown }>(value: T): Omit<T, 'lease'> {
  const { lease: _lease, ...rest } = value;
  return rest;
}
