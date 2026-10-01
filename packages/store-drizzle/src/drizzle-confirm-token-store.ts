import type { ConfirmTokenClaim, ConfirmTokenStore } from '@dudousxd/nestjs-agent-core';
import { eq, lt } from 'drizzle-orm';
import {
  type AgentDialect,
  type AgentDrizzleDb,
  type AgentSqliteDb,
  type AgentTables,
  affectedRows,
  agentDialectOf,
  agentTablesFor,
  asBuilder,
  mysqlAffectedRows,
} from './dialect.js';

/** The slice of Drizzle's MySQL insert builder used here, which the SQLite view does not have. */
interface MySqlInsertIgnore<Row> {
  ignore(): { values(value: Row): PromiseLike<unknown> };
}

/**
 * A production `ConfirmTokenStore` (`defineConfirmedTool`) over the `agent_confirm_token` table —
 * what makes a confirmed write single use across replicas.
 *
 * `claim` is one insert that skips a duplicate hash — `ON CONFLICT DO NOTHING` on SQLite and
 * Postgres, `INSERT IGNORE` on MySQL — so the primary key is the lock: of two concurrent
 * confirmations one inserts and the other touches no row. A statement that does not FAIL on the
 * duplicate, rather than an insert whose violation is caught, so it never aborts a surrounding
 * transaction. Only the token's SHA-256, the actor and the tool name are stored; call
 * {@link purgeExpired} from a scheduled job to drop the dead rows. The table comes from
 * `ensureAgentSchema` (or your own migration).
 */
export class DrizzleConfirmTokenStore implements ConfirmTokenStore {
  private readonly db: AgentSqliteDb;
  private readonly dialect: AgentDialect;
  private readonly t: AgentTables;

  constructor(db: AgentDrizzleDb) {
    this.dialect = agentDialectOf(db);
    this.t = agentTablesFor(this.dialect);
    this.db = asBuilder(db);
  }

  async claim(input: ConfirmTokenClaim): Promise<boolean> {
    const row = {
      hash: input.hash,
      actorRef: input.actorRef,
      tool: input.tool,
      expiresAt: input.expiresAt,
      createdAt: Date.now(),
    };
    const table = this.t.agentConfirmToken;
    if (this.dialect === 'mysql') {
      // MySQL's insert builder: `INSERT IGNORE`, and the header's affectedRows is 0 on a duplicate.
      const insert = this.db.insert(table) as unknown as MySqlInsertIgnore<typeof row>;
      return mysqlAffectedRows(await insert.ignore().values(row)) === 1;
    }
    const inserted = await affectedRows(
      this.dialect,
      this.db.insert(table).values(row).onConflictDoNothing(),
      table.hash,
    );
    return inserted === 1;
  }

  async release(hash: string): Promise<void> {
    await this.db.delete(this.t.agentConfirmToken).where(eq(this.t.agentConfirmToken.hash, hash));
  }

  async purgeExpired(now: number = Date.now()): Promise<number> {
    const table = this.t.agentConfirmToken;
    return affectedRows(
      this.dialect,
      this.db.delete(table).where(lt(table.expiresAt, now)),
      table.hash,
    );
  }
}
