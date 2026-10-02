import { type ActionProposal, canonicalActionProposalJson } from '@dudousxd/nestjs-agent-core';
import {
  BigIntType,
  type EntityProperty,
  EntityRepository,
  EntityRepositoryType,
  EntitySchema,
  type Platform,
  Type,
} from '@mikro-orm/core';
import { LongTextType, identityCollation } from './column-types';

/** Canonical JSON text preserves escaped NULs and lone UTF-16 surrogates on every database. */
export class ActionProposalJsonType extends Type<ActionProposal, string> {
  override convertToDatabaseValue(value: ActionProposal): string {
    return canonicalActionProposalJson(value);
  }
  override convertToJSValue(value: string): ActionProposal {
    return JSON.parse(value) as ActionProposal;
  }
  override getColumnType(prop: EntityProperty, platform: Platform): string {
    return new LongTextType().getColumnType(prop, platform);
  }
  override compareAsType(): string {
    return 'string';
  }
}

/** Decision and recoverable execution share one CAS row, so approval cannot lose its queued work. */
export class AgentActionProposal {
  /** SHA-256 of the logical global proposal id; never includes the scope. */
  id!: string;
  /** SHA-256 of the complete scope, including an explicit null tenant. */
  scopeKey!: string;
  /** Insert-only marker distinguishes this creator from concurrent or replayed creation. */
  insertionToken!: string;
  /** Hex UTF-16 code units preserve the public id's exact lexical ordering on every dialect. */
  sortKey!: string;
  payload!: ActionProposal;
  revision!: number;
  decision!: ActionProposal['decision'];
  executionStatus!: NonNullable<ActionProposal['execution']>['status'] | null;
  leaseExpiresAt!: number | null;
  proposalExpiresAt!: number | null;
  /** Zero marks legacy projections pending an explicit deployment backfill. */
  discoveryIndexVersion!: number;
  deliveryStatus!: string | null;
  deliveryLeaseExpiresAt!: number | null;
  outcomeIdKey!: string | null;
  replacementGroupKey!: string | null;
  createdAt!: number;
  declare [EntityRepositoryType]?: AgentActionProposalRepository;
}

export class AgentActionProposalRepository extends EntityRepository<AgentActionProposal> {}

export function agentActionProposalSchema(collation?: string): EntitySchema<AgentActionProposal> {
  const identity = identityCollation(collation);
  const epoch = () => new BigIntType('number');
  return new EntitySchema<AgentActionProposal>({
    class: AgentActionProposal,
    tableName: 'agent_action_proposal',
    repository: () => AgentActionProposalRepository,
    uniques: [{ name: 'agent_proposal_outcome_idx', properties: ['outcomeIdKey'] }],
    indexes: [
      {
        name: 'agent_proposal_replacement_idx',
        properties: ['scopeKey', 'replacementGroupKey', 'decision'],
      },
      {
        name: 'agent_proposal_delivery_idx',
        properties: ['deliveryStatus', 'deliveryLeaseExpiresAt', 'createdAt'],
      },

      { name: 'agent_proposal_scope_created_idx', properties: ['scopeKey', 'createdAt'] },
      {
        name: 'agent_proposal_scope_decision_idx',
        properties: ['scopeKey', 'decision', 'createdAt'],
      },
      {
        name: 'agent_proposal_work_lease_idx',
        properties: [
          'discoveryIndexVersion',
          'decision',
          'executionStatus',
          'leaseExpiresAt',
          'createdAt',
        ],
      },
      {
        name: 'agent_proposal_pending_expiry_idx',
        properties: ['discoveryIndexVersion', 'decision', 'proposalExpiresAt', 'createdAt'],
      },
      {
        name: 'agent_proposal_discovery_version_idx',
        properties: ['discoveryIndexVersion', 'createdAt'],
      },
    ],
    properties: {
      id: { type: 'string', length: 64, primary: true, ...identity },
      scopeKey: { type: 'string', length: 64, fieldName: 'scope_key', ...identity },
      insertionToken: { type: 'string', length: 36, fieldName: 'insertion_token', ...identity },
      sortKey: { type: LongTextType, fieldName: 'sort_key', ...identity },
      payload: { type: ActionProposalJsonType },
      revision: { type: epoch() },
      decision: { type: 'string', ...identity },
      executionStatus: {
        type: 'string',
        fieldName: 'execution_status',
        nullable: true,
        ...identity,
      },
      leaseExpiresAt: { type: epoch(), fieldName: 'lease_expires_at', nullable: true },
      proposalExpiresAt: { type: epoch(), fieldName: 'proposal_expires_at', nullable: true },
      discoveryIndexVersion: { type: 'integer', fieldName: 'discovery_index_version', default: 0 },
      deliveryStatus: { type: 'string', fieldName: 'delivery_status', nullable: true },
      deliveryLeaseExpiresAt: {
        type: epoch(),
        fieldName: 'delivery_lease_expires_at',
        nullable: true,
      },
      outcomeIdKey: {
        type: 'string',
        length: 64,
        fieldName: 'outcome_id_key',
        nullable: true,
        ...identity,
      },
      replacementGroupKey: {
        type: 'string',
        length: 64,
        fieldName: 'replacement_group_key',
        nullable: true,
        ...identity,
      },
      createdAt: { type: epoch(), fieldName: 'created_at' },
    },
  });
}
