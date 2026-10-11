import { BigIntType, EntityRepository, EntityRepositoryType, EntitySchema } from '@mikro-orm/core';
import { LongTextType, identityCollation } from './column-types';

/**
 * One event of a Poppy conversation, append-only, numbered per conversation. The primary key is the
 * position, so two appends racing for one cannot both win; `eventKey` (unique per conversation) is
 * what keeps a re-read turn from writing its reply twice. `event` is the event as JSON text.
 *
 * @experimental Personal Agent Protocol Draft 0.1.
 */
export class AgentPoppyEvent {
  conversationId!: string;
  seq!: number;
  id!: string;
  type!: string;
  /** JSON. */
  event!: string;
  eventKey!: string | null;
  /** Epoch-ms. */
  createdAt!: number;
  declare [EntityRepositoryType]?: AgentPoppyEventRepository;
}

/** Custom repository for {@link AgentPoppyEvent}. */
export class AgentPoppyEventRepository extends EntityRepository<AgentPoppyEvent> {}

/** Builds the `agent_poppy_event` schema. */
export function agentPoppyEventSchema(collation?: string): EntitySchema<AgentPoppyEvent> {
  const str = collation !== undefined ? { collation } : {};
  const identity = identityCollation(collation);
  return new EntitySchema<AgentPoppyEvent>({
    class: AgentPoppyEvent,
    tableName: 'agent_poppy_event',
    repository: () => AgentPoppyEventRepository,
    uniques: [{ name: 'agent_poppy_event_key_idx', properties: ['conversationId', 'eventKey'] }],
    indexes: [{ name: 'agent_poppy_event_id_idx', properties: ['conversationId', 'id'] }],
    properties: {
      conversationId: {
        type: 'string',
        primary: true,
        fieldName: 'conversation_id',
        length: 255,
        ...identity,
      },
      seq: { type: new BigIntType('number'), primary: true },
      id: { type: 'string', length: 64, ...identity },
      type: { type: 'string', length: 64, ...str },
      event: { type: LongTextType, ...str },
      eventKey: { type: 'string', fieldName: 'event_key', nullable: true, ...identity },
      createdAt: { type: new BigIntType('number'), fieldName: 'created_at' },
    },
  });
}
