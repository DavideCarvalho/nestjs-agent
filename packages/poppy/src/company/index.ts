/**
 * The Company side of Personal Agent Protocol ("Poppy", Draft 0.1) conversations (§7): your agent
 * as the Company Agent personal agents talk to. The wire types and the `PoppyStore` SPI are core's
 * (`@dudousxd/nestjs-agent-core`).
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec),
 * a spec still in development: this API WILL change as the spec evolves — possibly in breaking
 * ways, outside semver majors while it is a draft.
 */
export { AgentPoppyModule } from './agent-poppy.module.js';
export type {
  AgentPoppyModuleAsyncOptions,
  AgentPoppyModuleOptions,
} from './agent-poppy.options.js';
export type {
  PoppyAuthenticate,
  PoppyAuthFailure,
  PoppyAuthOptions,
  PoppyAuthRequest,
  PoppyAuthResult,
  PoppyPrincipal,
} from './auth.js';
export {
  POPPY_AUTHENTICATE_SLOT,
  POPPY_ISSUER_SLOT,
  globalPoppyAuthenticate,
  globalPoppyIssuer,
} from './auth.js';
export type {
  PoppyActionFormatter,
  PoppyActionOutcome,
  PoppyConversationsOptions,
  PoppyDirectHooks,
  PoppyHandoffDecision,
  PoppyHandoffHooks,
  PoppyHookContext,
  PoppyReadResult,
  PoppyStreamItem,
  PoppyTexts,
} from './conversations.js';
export {
  DEFAULT_POPPY_TEXTS,
  PoppyConversations,
  formatPoppyAction,
  poppyActorId,
} from './conversations.js';
export type { PoppyEndpoints } from './endpoints.js';
export {
  POPPY_ENDPOINTS_SLOT,
  announcePoppyEndpoints,
  announcedPoppyEndpoints,
  poppyConversationsUrl,
} from './endpoints.js';
export type {
  PoppyExchange,
  PoppyExpressRequest,
  PoppyHandlerOptions,
  PoppyStreamWriter,
} from './handler.js';
export {
  createPoppyHandler,
  expressExchange,
  nodeExchange,
  publicOrigin,
} from './handler.js';
export type { PoppyErrorCode, PoppySendBody } from './protocol.js';
export { PoppyError } from './protocol.js';
export { AGENT_POPPY_OPTIONS } from './tokens.js';
