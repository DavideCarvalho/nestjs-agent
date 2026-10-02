import type { ActionProposalOutcomeStore } from './spi/action-proposal-outcome-store.js';
import type {
  ActionProposalStore,
  ActionProposalSupersessionStore,
} from './spi/action-proposal-store.js';
import type { ActionProposalWorkerStore } from './spi/action-proposal-worker-store.js';
import type { AgentStore } from './spi/agent-store.js';
import type { BackgroundActorResolver } from './spi/background-actor-resolver.js';
import { isChatQueueStore } from './spi/chat-queue.js';
export type ActionProposalRuntimeStore = AgentStore &
  ActionProposalStore &
  ActionProposalWorkerStore &
  ActionProposalOutcomeStore &
  ActionProposalSupersessionStore;
export function assertIndependentActionCapabilities(
  store: AgentStore,
  resolver: BackgroundActorResolver | undefined,
): asserts store is ActionProposalRuntimeStore {
  const candidate = store as unknown as Record<string, unknown>;
  if (!resolver || typeof resolver.resolve !== 'function')
    throw new Error('Independent action mode requires a BackgroundActorResolver');
  if (!isChatQueueStore(store) || candidate.actionProposalAdmissionSupported === false)
    throw new Error('Independent action mode requires transactional thread admission');
  const required = [
    'createActionProposal',
    'getActionProposal',
    'listActionProposals',
    'decideActionProposal',
    'claimActionProposal',
    'extendActionProposalLease',
    'settleActionProposal',
    'claimNextActionProposal',
    'expireActionProposals',
    'getThreadActionProposalScope',
    'claimNextActionProposalOutcome',
    'admitActionProposalOutcome',
    'createReplacingActionProposal',
    'supersedeActionProposal',
  ];
  if (required.some((method) => typeof candidate[method] !== 'function'))
    throw new Error(
      'Independent action mode requires proposal, worker, outcome and admission capabilities on the conversation store',
    );
}
