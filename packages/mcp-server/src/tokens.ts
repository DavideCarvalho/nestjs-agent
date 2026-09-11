/**
 * `Symbol.for(...)` for the same reason core's tokens use it: pnpm peer multiplexing plus a dual
 * ESM/CJS build can load this package more than once, and a plain `Symbol()` would mint a distinct
 * token per copy. Naming follows the ecosystem convention `@dudousxd/nestjs-<lib>:<name>`.
 */
export const AGENT_MCP_SERVER_OPTIONS = Symbol.for('@dudousxd/nestjs-agent-mcp-server:options');

/**
 * The `ToolRegistry` holding tools derived from `@Mcp()` controller routes. Separate from the
 * agent's own `AGENT_TOOL_REGISTRY`: mounting an MCP server should not change what the agent loop
 * offers a model, and a route-derived tool is dispatched through a request pipeline a turn has no
 * request for. The MCP surface serves from both.
 */
export const AGENT_MCP_ROUTE_TOOLS = Symbol.for('@dudousxd/nestjs-agent-mcp-server:route-tools');
