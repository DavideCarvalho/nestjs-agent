import type { ConfirmTokenClaim, ConfirmTokenStore } from '@dudousxd/nestjs-agent-core';
import type { EntityManager } from '@mikro-orm/core';
import { type AgentSchemaOptions, assertAgentSchema, forkIn, tableIn } from './schema-name';
/** The table {@link import('./entities/agent-confirm-token.entity').AgentConfirmToken} maps. */
const TABLE = 'agent_confirm_token';

/** How many rows a native write touched, whatever the driver reports it as. */
function affected(result: unknown): number {
  const count = (result as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof count === 'number' ? count : 0;
}

/**
 * A production `ConfirmTokenStore` (`defineConfirmedTool`) over the `agent_confirm_token` table —
 * what makes a confirmed write single use across replicas. A POJO receiving an
 * {@link EntityManager}; each operation runs on a fresh `em.fork()`.
 *
 * `claim` is one insert that skips on a duplicate hash (`ON CONFLICT DO NOTHING`; `INSERT IGNORE`
 * on MySQL), so the primary key is the lock: of two concurrent confirmations one inserts and the
 * other touches no row. A statement that does not FAIL on the duplicate, rather than an insert whose
 * violation is caught, because on Postgres a failed statement aborts the transaction it ran in.
 * Only the token's SHA-256, the actor and the tool name are stored; call {@link purgeExpired} from a
 * scheduled job to drop the dead rows.
 */
export class MikroOrmConfirmTokenStore implements ConfirmTokenStore {
  private readonly schema: string | undefined;

  /** The table, qualified with the schema when one is set. */
  private get table(): string {
    return tableIn(this.em, TABLE, this.schema);
  }

  constructor(
    private readonly em: EntityManager,
    options: AgentSchemaOptions = {},
  ) {
    assertAgentSchema(em, options.schema);
    this.schema = options.schema;
  }

  private get mysql(): boolean {
    const platform = this.em.getPlatform().constructor.name.toLowerCase();
    return platform.includes('mysql') || platform.includes('maria');
  }

  async claim(input: ConfirmTokenClaim): Promise<boolean> {
    const sql = this.mysql
      ? `insert ignore into ${this.table} (hash, actor_ref, tool, expires_at, created_at) values (?, ?, ?, ?, ?)`
      : `insert into ${this.table} (hash, actor_ref, tool, expires_at, created_at) values (?, ?, ?, ?, ?) on conflict (hash) do nothing`;
    const result = await this.em
      .fork()
      .getConnection()
      .execute(sql, [input.hash, input.actorRef, input.tool, input.expiresAt, Date.now()], 'run');
    return affected(result) === 1;
  }

  async release(hash: string): Promise<void> {
    await this.em
      .fork()
      .getConnection()
      .execute(`delete from ${this.table} where hash = ?`, [hash], 'run');
  }

  async purgeExpired(now: number = Date.now()): Promise<number> {
    const result = await this.em
      .fork()
      .getConnection()
      .execute(`delete from ${this.table} where expires_at < ?`, [now], 'run');
    return affected(result);
  }
}
