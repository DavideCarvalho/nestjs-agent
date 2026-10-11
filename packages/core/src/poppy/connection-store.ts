/**
 * What one owner (a person/account of this app) holds at one Company: the Company's issuer and
 * domain, the scope granted, and the sealed client state (User ID, DPoP key, Account Token, Session
 * Tokens). `status`: `pending` while signing in, `active` with an Account Token, `revoked` after a
 * disconnect (either side).
 */
export interface PoppyConnectionRecord {
  owner: string;
  issuer: string;
  domain: string;
  organization: string;
  scope: string;
  status: 'pending' | 'active' | 'revoked';
  /** Sealed `CompanyState` of the poppy-client (see `Sealer`). */
  state: string;
  createdAt: number;
  updatedAt: number;
}

/** A sign-in started by the `connect` tool, completed on this app's connect page. */
export interface PoppyPendingConnect {
  /** Unguessable (128 bits): the connect page's URL is a bearer link. */
  id: string;
  owner: string;
  domain: string;
  issuer: string;
  organization: string;
  scope: string;
  /** The actor the turn ran as, to decide the parked call on completion. */
  actor: { id: string; roles?: string[]; tenantRef?: string } | null;
  threadId: string | null;
  runId: string | null;
  toolCallId: string | null;
  /** Sealed per-method state (PKCE verifier, mediated sign-in id). Never the credentials. */
  flow: string | null;
  status: 'open' | 'connected' | 'failed';
  expiresAt: number;
  createdAt: number;
}

/**
 * Where an app's Poppy connections (its agent acting at OTHER Poppy companies for its users) and
 * their in-flight sign-ins live. The client state in {@link PoppyConnectionRecord.state} is sealed
 * by the caller before it gets here: a store never sees a token.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec).
 */
export interface PoppyConnectionStore {
  listConnections(owner: string): Promise<PoppyConnectionRecord[]>;
  getConnection(owner: string, issuer: string): Promise<PoppyConnectionRecord | null>;
  saveConnection(record: PoppyConnectionRecord): Promise<void>;
  deleteConnection(owner: string, issuer: string): Promise<void>;
  createPending(record: PoppyPendingConnect): Promise<void>;
  getPending(id: string): Promise<PoppyPendingConnect | null>;
  updatePending(
    id: string,
    patch: Partial<Pick<PoppyPendingConnect, 'flow' | 'status'>>,
  ): Promise<void>;
}

/** Process-local {@link PoppyConnectionStore} — tests and single-instance dev. */
export class InMemoryPoppyConnectionStore implements PoppyConnectionStore {
  readonly #connections = new Map<string, PoppyConnectionRecord>();
  readonly #pending = new Map<string, PoppyPendingConnect>();

  async listConnections(owner: string) {
    return [...this.#connections.values()].filter((c) => c.owner === owner).map((c) => ({ ...c }));
  }
  async getConnection(owner: string, issuer: string) {
    const found = this.#connections.get(`${owner}\n${issuer}`);
    return found ? { ...found } : null;
  }
  async saveConnection(record: PoppyConnectionRecord) {
    this.#connections.set(`${record.owner}\n${record.issuer}`, { ...record });
  }
  async deleteConnection(owner: string, issuer: string) {
    this.#connections.delete(`${owner}\n${issuer}`);
  }
  async createPending(record: PoppyPendingConnect) {
    if (!this.#pending.has(record.id)) this.#pending.set(record.id, structuredClone(record));
  }
  async getPending(id: string) {
    const found = this.#pending.get(id);
    return found ? structuredClone(found) : null;
  }
  async updatePending(id: string, patch: Partial<Pick<PoppyPendingConnect, 'flow' | 'status'>>) {
    const found = this.#pending.get(id);
    if (found) Object.assign(found, patch);
  }
}

/** The tables the SQL connection stores keep connections and pending connects in. */
export const POPPY_CONNECTION_TABLES = {
  connections: 'agent_poppy_connection',
  pending: 'agent_poppy_connect',
} as const;
