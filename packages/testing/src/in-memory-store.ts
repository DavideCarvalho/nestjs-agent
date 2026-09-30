// The store lives in core now (it is `AgentModule`'s zero-config default); re-exported here so
// `@dudousxd/nestjs-agent-testing` keeps offering it next to the other fakes.
export {
  InMemoryAgentStore,
  type GovernanceMessageRow,
  type GovernancePendingApprovalRow,
  type GovernanceRunRow,
  type GovernanceThreadRow,
  type GovernanceToolCallRow,
  type GovernanceUsageRow,
} from '@dudousxd/nestjs-agent-core';
