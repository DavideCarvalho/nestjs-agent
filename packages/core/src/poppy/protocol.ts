/**
 * The wire types of Personal Agent Protocol ("Poppy", Draft 0.1, §7) conversations — what the
 * conversation store keeps and every Poppy surface reads. The runtime (endpoint, parsing, errors)
 * is `@dudousxd/nestjs-agent-poppy`'s; the types live here so a store adapter needs only core.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec),
 * a spec still in development: this API WILL change as the spec evolves — possibly in breaking
 * ways, outside semver majors while it is a draft.
 */

/** The `protocol_version` this surface implements. */
export const POPPY_PROTOCOL_VERSION = '0.1';

/** The `type` of this surface's entry in `poppy.json` `agent.protocols` (§7.1). */
export const POPPY_PROTOCOL_TYPE = 'poppy';

/** The account scopes the protocol defines (§4.4). Companies may add their own. */
export const POPPY_READ_SCOPE = 'poppy:read';
export const POPPY_WRITE_SCOPE = 'poppy:write';

export type PoppyStatus = 'working' | 'idle' | 'queued' | 'closed';
export type PoppyResponder = 'agent' | 'human';
export type PoppySender = 'agent' | 'human';

/** Facts about the User's situation (§7.4). Other fields are kept as sent. */
export interface PoppyContext {
  locale?: string;
  time_zone?: string;
  user_available?: boolean;
  [field: string]: unknown;
}

/** A message as the Personal Agent sends it (§7.4). */
export interface PoppyInboundMessage {
  id: string;
  sender: PoppySender;
  text?: string;
  data?: Record<string, unknown>;
  context?: PoppyContext;
}

/** A message as it appears in a `message` event (§7.5): `role` says which side it came from. */
export interface PoppyEventMessage {
  id: string;
  role: 'user' | 'company';
  sender: PoppySender;
  text?: string;
  data?: Record<string, unknown>;
  context?: PoppyContext;
}

export type PoppyEventType =
  | 'message'
  | 'state'
  | 'authorization'
  | 'user_requested'
  | 'direct_opened'
  | 'direct_closed';

/** One event of a conversation (§7.5): `id`, `type`, `created_at`, and the type's own fields. */
export interface PoppyEvent {
  id: string;
  type: PoppyEventType | (string & {});
  created_at: string;
  [field: string]: unknown;
}

/** The type-specific fields of a new event — what the store appends. */
export type PoppyEventBody =
  | { type: 'message'; message: PoppyEventMessage }
  | { type: 'state'; status: PoppyStatus; responder: PoppyResponder }
  | { type: 'authorization'; error: 'sign_in_required' | 'insufficient_scope'; scope?: string }
  | { type: 'user_requested'; reason: string }
  | { type: 'direct_opened' | 'direct_closed'; conversation_id: string };
