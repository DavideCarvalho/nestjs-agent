export {
  AgentMcpProtectedResourceModule,
  AgentMcpServerModule,
  AgentMcpServerOptionsModule,
} from './agent-mcp-server.module.js';
export { AgentMcpServerController } from './agent-mcp-server.controller.js';
export type {
  AgentMcpServerModuleAsyncOptions,
  AgentMcpServerModuleOptions,
  McpRouteExposureOptions,
} from './agent-mcp-server.options.js';
export {
  createAgentMcpServer,
  type CreateAgentMcpServerOptions,
  type McpToolContextResolver,
} from './agent-mcp-server.js';
export { authenticateMcpRequest } from './authenticate.js';
export { BearerTokenActorResolver, type McpBearerGrant } from './bearer-token-actor-resolver.js';
export {
  assertToolExposedOverMcp,
  isToolExposedOverMcp,
  mcpExposureRefusal,
  McpToolNotExposedError,
  type McpActionPolicy,
  type McpExposureInput,
} from './exposed-tools.js';
export {
  actorFromAuthInfo,
  isActor,
  McpUnauthenticatedError,
  type McpAuthInfo,
} from './mcp-actor.js';
export {
  McpChallengeException,
  McpChallengeFilter,
  type McpChallenge,
  type McpChallengeError,
} from './mcp-challenge.js';
export { McpSessionStore, type McpSession } from './mcp-sessions.js';
export {
  asPersonalAgent,
  poppyActorResolver,
  type PoppyActorResolverOptions,
} from './poppy-actor-resolver.js';
// The Poppy slot contracts are core's (shared with `@dudousxd/nestjs-agent-poppy`), re-exported.
export {
  announcedPoppyIssuer,
  globalPoppyAuthenticate,
  POPPY_AUTHENTICATE_SLOT,
  POPPY_ISSUER_SLOT,
  type PoppyAuthenticate,
  type PoppyAuthFailure,
  type PoppyAuthOptions,
  type PoppyAuthRequest,
  type PoppyAuthResult,
  type PoppyPrincipal,
} from '@dudousxd/nestjs-agent-core';
export {
  protectedResourceMetadata,
  type McpOAuthOptions,
  type ProtectedResourceMetadata,
} from './protected-resource.js';
export { McpRouteDiscoveryService } from './routes/mcp-route-discovery.service.js';
export {
  defaultMcpRoutePrincipal,
  McpRouteDispatcher,
  McpRouteHttpError,
  type McpRoutePrincipal,
  type McpRoutePrincipalFactory,
  type McpRouteRef,
} from './routes/mcp-route-dispatcher.js';
export {
  defaultRouteToolName,
  McpRouteToolNameCollisionError,
} from './routes/mcp-route-tools.js';
export {
  Mcp,
  McpRouteDeclarationError,
  readMcpRouteMetadata,
  type McpRouteOptions,
} from './routes/mcp.decorator.js';
export {
  readNestRoute,
  ROUTE_PARAM,
  type NestRoute,
  type RouteParamDeclaration,
} from './routes/nest-route-metadata.js';
export { routeInputSchema, type McpRouteInput } from './routes/route-input-schema.js';
export { toMcpInputSchema, type McpInputSchema } from './tool-json-schema.js';
export {
  AGENT_MCP_ROUTE_TOOLS,
  AGENT_MCP_SERVER_OPTIONS,
  AGENT_MCP_SERVER_PATH,
} from './tokens.js';
