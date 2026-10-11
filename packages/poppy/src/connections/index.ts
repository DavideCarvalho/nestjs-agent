/**
 * @experimental Personal Agent Protocol ("Poppy") Draft 0.1 — this app's agent acting on OTHER
 * Poppy Companies for its users. Tracks the spec (https://personalagentprotocol.org/docs/spec);
 * WILL change, possibly in breaking ways.
 */
import { generateEs256Key } from '../client/keys.js';

export {
  AgentPoppyConnectionsModule,
  type AgentPoppyConnectionsModuleAsyncOptions,
} from './agent-poppy-connections.module.js';
export { AgentPoppyConnectionsController } from './agent-poppy-connections.controller.js';
export { AgentPoppyConnectionsRuntime } from './agent-poppy-connections.runtime.js';
export {
  type AgentPoppyConnectionsModuleOptions,
  DEFAULT_POPPY_CONNECTIONS_TEXTS,
  normalizeDomain,
  type PoppyAgentKey,
  type PoppyCompanyPolicy,
  type PoppyConnectionToolsOptions,
  type PoppyConnectionsApiRequest,
  type PoppyConnectionsTexts,
  type TwoStepConvention,
} from './config.js';
export { Sealer } from './crypto.js';
export {
  createPoppyConnectionsHandler,
  defaultConnectRenderer,
  type PoppyConnectionsExchange,
  type PoppyConnectRenderer,
  type PoppyConnectView,
} from './http.js';
export {
  continueAfterConnect,
  type PoppyFollow,
  type PoppyResumeHost,
  type PoppyResumeStore,
  resumeAfterConnect,
} from './resume.js';
export {
  normalizeKeys,
  PoppyCompanyNotAllowedError,
  type PoppyCompanyReply,
  PoppyConnections,
  type PoppyConnectionsOptions,
  type PoppyConnectionView,
  type PoppyConnectPageData,
} from './service.js';
export { AGENT_POPPY_CONNECTIONS_OPTIONS } from './tokens.js';
export {
  type CallCompanyToolOptions,
  callCompanyTool,
  previewCompanyWrite,
  registerPoppyConnectionTools,
  talkToCompany,
} from './tools.js';

/**
 * A fresh signing key for `identity.keys` (store the JSON in an env var).
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1.
 */
export async function generatePoppyAgentKey(): Promise<Record<string, unknown>> {
  return (await generateEs256Key()).privateJwk as Record<string, unknown>;
}
