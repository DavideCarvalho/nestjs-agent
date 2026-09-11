/**
 * `Symbol.for(...)` for the same reason core's tokens use it: pnpm peer multiplexing plus a dual
 * ESM/CJS build can load this package more than once, and a plain `Symbol()` would mint a distinct
 * token per copy. Naming follows the ecosystem convention `@dudousxd/nestjs-<lib>:<name>`.
 */
export const AGENT_MCP_SERVER_OPTIONS = Symbol.for('@dudousxd/nestjs-agent-mcp-server:options');
