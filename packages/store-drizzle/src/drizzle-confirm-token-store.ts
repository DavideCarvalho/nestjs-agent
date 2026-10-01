import type { ConfirmTokenClaim, ConfirmTokenStore } from '@dudousxd/nestjs-agent-core';
import { eq, lt } from 'drizzle-orm';
import { type AgentDrizzleDb, agentConfirmToken } from './schema.js';

/**
 * A production `ConfirmTokenStore` (`defineConfirmedTool`) over the `agent_confirm_token` table —
 * what makes a confirmed write single use across replicas.
 *
 * `claim` is one `INSERT … ON CONFLICT DO NOTHING RETURNING`, so the primary key is the lock: of two
 * concurrent confirmations one inserts and the other touches no row. A statement that does not FAIL
 * on the duplicate, rather than an insert whose violation is caught, so it never aborts a
 * surrounding transaction. Only the token's SHA-256, the actor and the tool name are stored; call
 * {@link purgeExpired} from a scheduled job to drop the dead rows. The table comes from
 * `ensureAgentSchema` (or your own migration).
 */
export class DrizzleConfirmTokenStore implements ConfirmTokenStore {
  constructor(private readonly db: AgentDrizzleDb) {}

  async claim(input: ConfirmTokenClaim): Promise<boolean> {
    const inserted = await this.db
      .insert(agentConfirmToken)
      .values({
        hash: input.hash,
        actorRef: input.actorRef,
        tool: input.tool,
        expiresAt: input.expiresAt,
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .returning({ hash: agentConfirmToken.hash });
    return inserted.length === 1;
  }

  async release(hash: string): Promise<void> {
    await this.db.delete(agentConfirmToken).where(eq(agentConfirmToken.hash, hash));
  }

  async purgeExpired(now: number = Date.now()): Promise<number> {
    const purged = await this.db
      .delete(agentConfirmToken)
      .where(lt(agentConfirmToken.expiresAt, now))
      .returning({ hash: agentConfirmToken.hash });
    return purged.length;
  }
}
