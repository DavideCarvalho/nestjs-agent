/**
 * The Personal Agent Protocol ("Poppy", Draft 0.1) reference client — a Personal Agent for any
 * runtime: discovery, agent identity (`agent.json` + JWKS), Direct / Device / Mediated sign-in,
 * Session and Account Tokens with DPoP, the conversation endpoint and company MCP / OpenAPI tools.
 * The `poppy-agent` CLI ships with this package.
 *
 * The SAME client as `@adonis-agora/agent/poppy-client` (same API, same conformance suite against
 * the same fake Company), carried here as a copy because Aviary never depends on Agora (see
 * `independent-ecosystems.spec.ts` in core). Its module tree is framework-agnostic — `node:*`,
 * `jose` and the MCP SDK client only, checked by `framework-agnostic.spec.ts`.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec),
 * a spec still in development: this API WILL change as the spec evolves — possibly in breaking
 * ways, outside semver majors while it is a draft.
 */
export { apiBaseUrl, callOpenApi, listApis, loadOpenApi, pickApi } from './api.js';
export { autoSubmitFormHtml, createBrowserAssertion, serveOneShotPage } from './browser.js';
export {
  CompanyClient,
  PoppyAgent,
  type PoppyAgentOptions,
  type SignInResult,
  throwForResponse,
} from './company.js';
export {
  ConversationClient,
  type FollowOptions,
  newMessageId,
  poppyProtocol,
  type StreamItem,
} from './conversations.js';
export {
  authServerMetadataUrl,
  type Discovered,
  discover,
  HttpJsonCache,
  SUPPORTED_MAJOR_VERSIONS,
  validateMetadata,
  validatePoppyDocument,
  wellKnownUrlFor,
} from './discovery.js';
export { DpopKey, htuOf } from './dpop.js';
export {
  ConversationError,
  DiscoveryError,
  OAuthError,
  PoppyError,
  ResourceAuthError,
} from './errors.js';
export { PoppyHttp } from './http.js';
export { AgentIdentity, type IdentityConfig } from './identity.js';
export { startIdentityServer, waitForRelayedCallback } from './identity-server.js';
export { generateEs256Key, type StoredKey } from './keys.js';
export { ask, DEFAULT_MODEL } from './llm.js';
export { connectMcp, type McpConnection } from './mcp.js';
export {
  completeDirectSignIn,
  deviceSignIn,
  eligibleSignInTypes,
  type MediatedOutcome,
  mediatedSignIn,
  type PendingDirectSignIn,
  pollDeviceSignInOnce,
  type SignInType,
  startDirectSignIn,
  submitMediatedCode,
} from './signin.js';
export { parseSse } from './sse.js';
export { defaultStatePath, StateStore } from './store.js';
export { TokenClient } from './token-client.js';
export type * from './types.js';
