import type {
  PoppyConnectionRecord,
  PoppyConnectionStore,
  PoppyPendingConnect,
} from '@dudousxd/nestjs-agent-core';

/**
 * The slice of a Redis client {@link RedisPoppyConnectionStore} uses. An `ioredis` client has it as
 * is (`new RedisPoppyConnectionStore(redis)`); adapt any other driver to these commands.
 */
export interface RedisPoppyConnectionClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, ex: 'EX', seconds: number, nx: 'NX'): Promise<unknown>;
  set(key: string, value: string, keepTtl: 'KEEPTTL'): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<unknown>;
  srem(key: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
}

export interface RedisPoppyConnectionStoreOptions {
  /** Prepended to every key. Default `agent:poppy-connections:`. */
  prefix?: string;
}

/** How long a pending connect outlives its expiry, so a late completion still finds it. */
const PENDING_GRACE_SECONDS = 3600;

/**
 * A `PoppyConnectionStore` (`AgentPoppyConnectionsModule`) shared by every replica, over Redis:
 * JSON values, and one set per owner indexing its issuers. A pending connect is `SET … EX … NX`
 * (created once) and expires on its own an hour after its `expiresAt`. The client state arrives
 * sealed: no token is ever stored in the clear.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec).
 */
export class RedisPoppyConnectionStore implements PoppyConnectionStore {
  private readonly p: string;

  constructor(
    private readonly redis: RedisPoppyConnectionClient,
    options: RedisPoppyConnectionStoreOptions = {},
  ) {
    this.p = options.prefix ?? 'agent:poppy-connections:';
  }

  private connectionKey = (owner: string, issuer: string) => `${this.p}conn:${owner}\n${issuer}`;
  private ownerIndex = (owner: string) => `${this.p}owner:${owner}`;
  private pendingKey = (id: string) => `${this.p}pending:${id}`;

  private async read<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async listConnections(owner: string): Promise<PoppyConnectionRecord[]> {
    const issuers = await this.redis.smembers(this.ownerIndex(owner));
    const found = await Promise.all(
      issuers.map((issuer) => this.read<PoppyConnectionRecord>(this.connectionKey(owner, issuer))),
    );
    return found.filter((connection): connection is PoppyConnectionRecord => connection !== null);
  }

  getConnection(owner: string, issuer: string): Promise<PoppyConnectionRecord | null> {
    return this.read<PoppyConnectionRecord>(this.connectionKey(owner, issuer));
  }

  async saveConnection(record: PoppyConnectionRecord): Promise<void> {
    await this.redis.set(this.connectionKey(record.owner, record.issuer), JSON.stringify(record));
    await this.redis.sadd(this.ownerIndex(record.owner), record.issuer);
  }

  async deleteConnection(owner: string, issuer: string): Promise<void> {
    await this.redis.del(this.connectionKey(owner, issuer));
    await this.redis.srem(this.ownerIndex(owner), issuer);
  }

  async createPending(record: PoppyPendingConnect): Promise<void> {
    const ttl = Math.max(
      1,
      Math.ceil((record.expiresAt - Date.now()) / 1000) + PENDING_GRACE_SECONDS,
    );
    await this.redis.set(this.pendingKey(record.id), JSON.stringify(record), 'EX', ttl, 'NX');
  }

  getPending(id: string): Promise<PoppyPendingConnect | null> {
    return this.read<PoppyPendingConnect>(this.pendingKey(id));
  }

  async updatePending(
    id: string,
    patch: Partial<Pick<PoppyPendingConnect, 'flow' | 'status'>>,
  ): Promise<void> {
    const found = await this.getPending(id);
    if (!found) return;
    await this.redis.set(this.pendingKey(id), JSON.stringify({ ...found, ...patch }), 'KEEPTTL');
  }
}
