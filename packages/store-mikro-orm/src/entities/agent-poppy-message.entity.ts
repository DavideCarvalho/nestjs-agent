import { BigIntType, EntityRepository, EntityRepositoryType, EntitySchema } from '@mikro-orm/core';
import { LongTextType, identityCollation } from './column-types';

/**
 * An accepted Poppy message, one row per (owner, message id) — the primary key is the idempotency
 * lock that makes two deliveries of one message one (§7.3). `response` is what the first got, as
 * JSON text.
 *
 * @experimental Personal Agent Protocol Draft 0.1.
 */
export class AgentPoppyMessage {
  owner!: string;
  messageId!: string;
  fingerprint!: string;
  conversationId!: string;
  /** JSON. */
  response!: string;
  /** Epoch-ms. */
  createdAt!: number;
  declare [EntityRepositoryType]?: AgentPoppyMessageRepository;
}

/** Custom repository for {@link AgentPoppyMessage}. */
export class AgentPoppyMessageRepository extends EntityRepository<AgentPoppyMessage> {}

/** Builds the `agent_poppy_message` schema. */
export function agentPoppyMessageSchema(collation?: string): EntitySchema<AgentPoppyMessage> {
  const str = collation !== undefined ? { collation } : {};
  const identity = identityCollation(collation);
  return new EntitySchema<AgentPoppyMessage>({
    class: AgentPoppyMessage,
    tableName: 'agent_poppy_message',
    repository: () => AgentPoppyMessageRepository,
    properties: {
      owner: { type: 'string', primary: true, length: 255, ...identity },
      messageId: {
        type: 'string',
        primary: true,
        fieldName: 'message_id',
        length: 255,
        ...identity,
      },
      fingerprint: { type: 'string', ...identity },
      conversationId: { type: 'string', fieldName: 'conversation_id', ...identity },
      response: { type: LongTextType, ...str },
      createdAt: { type: new BigIntType('number'), fieldName: 'created_at' },
    },
  });
}
