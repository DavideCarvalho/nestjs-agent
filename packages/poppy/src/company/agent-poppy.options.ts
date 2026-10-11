import type { Actor, PoppyStore } from '@dudousxd/nestjs-agent-core';
import type { DynamicModule, InjectionToken, OptionalFactoryDependency } from '@nestjs/common';
import type { PersonalAgentActionPolicy, PersonalAgentTurnService } from '../turn.js';
import type { PoppyAuthenticate, PoppyPrincipal } from './auth.js';
import type {
  PoppyActionFormatter,
  PoppyDirectHooks,
  PoppyHandoffHooks,
  PoppyTexts,
} from './conversations.js';

/**
 * `AgentPoppyModule.forRoot()` options. Exposes an agent as the Company Agent of Personal Agent
 * Protocol ("Poppy", Draft 0.1) conversations — https://personalagentprotocol.org, §7.
 *
 * Session Tokens are verified by the resolver an authorization server installs in
 * `Symbol.for('@adonis-agora/poppy:authenticate')`, or by `authenticate`. Advertise the endpoint
 * in `poppy.json` as `agent.protocols: [{ type: 'poppy', endpoint: 'https://…/poppy/conversations' }]`.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec),
 * a spec still in development: this API WILL change as the spec evolves — possibly in breaking
 * ways, outside semver majors while it is a draft.
 */
export interface AgentPoppyModuleOptions {
  /**
   * The endpoint path from the server root. Default `'poppy/conversations'`. Mounted on the
   * Express app itself, ahead of Nest's router: a global prefix does not apply — include it here
   * if you want one.
   */
  path?: string;
  /**
   * Public origin of this app — the URL a DPoP proof is checked against. Set it in production
   * (behind a proxy); the fallback is the request's own protocol and Host. Also REQUIRED for the
   * module to announce `{baseUrl}/{path}` in `Symbol.for('@adonis-agora/poppy:endpoints')`, where
   * the authorization server reads it for `poppy.json` — without it the endpoint is not announced.
   */
  baseUrl?: string;
  /** The registered agent that answers. Default: `AgentModule`'s default agent. */
  agent?: string;
  /** Verifies Session Tokens; overrides the global resolver. Neither → the endpoint answers 501. */
  authenticate?: PoppyAuthenticate;
  /**
   * The actor of a principal the resolver gave none (`principal.actor`). Gets the default: the
   * account (`{ id: accountId }`) when signed in, `poppy:<hash of client and user>` signed out.
   * `personal_agent` and the token's `scope:<id>` roles are added whatever this returns.
   */
  actorFor?: (principal: PoppyPrincipal, defaults: Actor) => Actor | Promise<Actor>;
  /**
   * Where conversations and their events live. Default: the `AGENT_POPPY_STORE` a store module
   * binds (Drizzle, MikroORM, Redis), else an in-memory store — one process only, with a warning.
   */
  store?: PoppyStore;
  /** What happens to `action` calls that park for approval. Default `'approve-delegated'`. */
  actions?: PersonalAgentActionPolicy;
  /** Bring a person in (§7.9). Without it, a handoff is declined by the Company Agent. */
  handoff?: PoppyHandoffHooks;
  /** Notified when a Direct Conversation opens or closes (§7.10). */
  direct?: PoppyDirectHooks;
  /** What the Company Agent says on its own. */
  texts?: Partial<PoppyTexts>;
  /**
   * Words each action of a reply (executed, failed, refused) — the reply's text always tells them,
   * `data.actions` carries them structured. Default: `texts.action*` + the confirmation detail.
   */
  formatAction?: PoppyActionFormatter;
  /** Give up on a turn after this many ms. Default 120 000. */
  timeoutMs?: number;
  /** Largest accepted request body, in bytes. Default 1 MiB (Nest's own body parser limit applies first). */
  maxBodyBytes?: number;
  /** Cap on a read's `wait`, in seconds. Default 30. */
  maxWaitSeconds?: number;
  /** Close an event stream after this long (the Personal Agent reconnects). Default 5 min. */
  streamMaxMs?: number;
  /** Prune events older than this (a cursor there is `cursor_expired`). Default: keep them. */
  retentionMs?: number;
  /**
   * Execute, in this process, the work of a run its runner left waiting for a worker while a reply
   * is read. None by default: `AgentModule`'s durable runner drives the runs it starts itself, so
   * only a custom `service` whose dispatcher merely persists a run needs this.
   */
  drive?: (runId: string) => Promise<void>;
  /** What runs a turn. Default: `AgentModule`'s `AgentService`. */
  service?: PersonalAgentTurnService;
}

/**
 * `AgentPoppyModule.forRootAsync()` options: the same options from a factory (config service,
 * secrets…).
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec).
 */
export interface AgentPoppyModuleAsyncOptions {
  imports?: DynamicModule['imports'];
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useFactory: (...deps: never[]) => AgentPoppyModuleOptions | Promise<AgentPoppyModuleOptions>;
}
