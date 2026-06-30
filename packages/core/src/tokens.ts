/**
 * Public, cross-lib-discoverable DI tokens.
 *
 * These use `Symbol.for(...)` (the global symbol registry) on purpose: pnpm peer
 * multiplexing + dual ESM/CJS can load `core` more than once, and a plain `Symbol()`
 * would mint a distinct token per copy and break DI across package boundaries. A
 * registered symbol collapses every copy onto the same token, and lets a sibling lib
 * resolve our injectables by name without importing our internals.
 *
 * Naming convention (ecosystem-wide): `@dudousxd/nestjs-<lib>:<name>`.
 */
export const AGENT_OPTIONS = Symbol.for('@dudousxd/nestjs-agent:options');
export const AGENT_STORE = Symbol.for('@dudousxd/nestjs-agent:store');
export const AGENT_RUNNER = Symbol.for('@dudousxd/nestjs-agent:runner');
export const AGENT_SINK = Symbol.for('@dudousxd/nestjs-agent:sink');
export const AGENT_MODEL = Symbol.for('@dudousxd/nestjs-agent:model');
export const AGENT_ROLES_POLICY = Symbol.for('@dudousxd/nestjs-agent:roles-policy');
export const AGENT_QUOTA_STORE = Symbol.for('@dudousxd/nestjs-agent:quota-store');
export const AGENT_TOOL_REGISTRY = Symbol.for('@dudousxd/nestjs-agent:tool-registry');
export const AGENT_REGISTRY = Symbol.for('@dudousxd/nestjs-agent:agent-registry');
// Per-agent deps factory. A Symbol.for token (not the class) so DI survives tsup's dual
// index/durable bundles, which each get their own copy of the AgentDepsFactory class.
export const AGENT_DEPS_FACTORY = Symbol.for('@dudousxd/nestjs-agent:deps-factory');
