import type { MemoryOrigin } from '@dudousxd/nestjs-agent-core';
import { EntityRepository, EntityRepositoryType, EntitySchema } from '@mikro-orm/core';

/**
 * One thing the assistant believes, held at one scope — the row behind
 * {@link import('@dudousxd/nestjs-agent-core').MemoryRecord}.
 *
 * `scope` is an OPAQUE token the host mints (`actor:…`, `tenant:…`, whatever axis a deployment
 * scopes by), which is what lets this package own the table at all: there is nothing here for a host
 * to relate its own entities to, so owning the rows takes nothing away from it. The write path
 * (`remember`, `writeMemory`) and the read-back (`GET /agent/memories`, `DELETE /agent/memories/:id`)
 * are already the library's.
 *
 * The origin is flattened into columns rather than stored as JSON so a host's console can filter and
 * sweep on it — every memory a run wrote, every memory concluded in a thread that is gone.
 * `originThreadId` is deliberately NOT a foreign key: a memory outlives the conversation it came
 * from, and a cascade would delete beliefs when a transcript aged out.
 */
export class AgentMemory {
  id!: string;
  /** The opaque scope token. Unique with {@link key}: one fact per key per scope. */
  scope!: string;
  /** What the fact is ABOUT. Two scopes sharing a key are one question answered twice. */
  key!: string;
  /** The fact itself, one line, as the model reads it. */
  text!: string;
  originAuthor!: MemoryOrigin['author'];
  /** A pointer that is allowed to dangle — see the class note. */
  originThreadId?: string | null;
  originRunId?: string | null;
  originActorRef?: string | null;
  /** Always-on: carried in every prompt. Set by a host's console, never by a write. */
  pinned!: boolean;
  createdAt!: Date;
  updatedAt!: Date;
  declare [EntityRepositoryType]?: AgentMemoryRepository;
}

/** Custom repository for {@link AgentMemory}, so a host can inject it by type instead of passing the entity to every `em` call. */
export class AgentMemoryRepository extends EntityRepository<AgentMemory> {}

/**
 * Builds the `agent_memory` schema.
 *
 * One unique index, on (`scope`, `key`) — what `write` upserts against, and what makes a duplicate
 * answer to one question impossible rather than merely unlikely. It doubles as the index every read
 * uses: `list` filters `scope in (…)`, which is that index's leading column, so a second index on
 * `scope` alone would be maintained on every write and read by nothing.
 */
export function agentMemorySchema(collation?: string): EntitySchema<AgentMemory> {
  const str = collation !== undefined ? { collation } : {};
  return new EntitySchema<AgentMemory>({
    class: AgentMemory,
    tableName: 'agent_memory',
    repository: () => AgentMemoryRepository,
    uniques: [{ name: 'agent_memory_scope_key_uq', properties: ['scope', 'key'] }],
    properties: {
      id: { type: 'string', primary: true, ...str },
      scope: { type: 'string', length: 120, ...str },
      key: { type: 'string', length: 120, ...str },
      text: { type: 'text' },
      originAuthor: { type: 'string', length: 16, fieldName: 'origin_author', ...str },
      originThreadId: {
        type: 'string',
        nullable: true,
        fieldName: 'origin_thread_id',
        ...str,
      },
      originRunId: { type: 'string', nullable: true, fieldName: 'origin_run_id', ...str },
      originActorRef: { type: 'string', nullable: true, fieldName: 'origin_actor_ref', ...str },
      pinned: { type: 'boolean', default: false },
      createdAt: { type: 'datetime', fieldName: 'created_at' },
      updatedAt: { type: 'datetime', fieldName: 'updated_at' },
    },
  });
}
