---
"@dudousxd/nestjs-agent-mcp-server": minor
---

The MCP server is NestJS's `@nestjs/mcp`. `AgentMcpServerModule` mounts `@nestjs/mcp`'s endpoint (Streamable HTTP, stateless, the 2025 and 2026-07-28 protocol revisions, stdio) and serves the agent's tools on it, beside whatever `@Tool()` / `@Resource()` / `@Prompt()` methods the application declares. What `@nestjs/mcp` has no word for stays this package's: the agent's `ActorResolver` (401 with its `WWW-Authenticate` challenge), the personal-agent `insufficient_scope` step-up, the `action` exposure policy, `allowedTools`, `@Mcp()` routes, and per-caller listing — the server built for a request registers only the tools its actor may use. Built on the MCP SDK v2 (`@modelcontextprotocol/server`).

`@nestjs/mcp` has no hook for tools that are not decorated methods, nor for listing a tool to one caller and not another, so the module wraps its internal `McpServerFactory`; `@nestjs/mcp` is pinned (`>=0.0.4 <0.0.5`) and a test fails if the factory stops being found.

Breaking:

- NestJS 12, Node 22, `@nestjs/mcp` as a peer; MCP SDK v2 instead of `@modelcontextprotocol/sdk`.
- Stateless: `McpSessionStore`, `McpSession` and the session-ownership checks are gone (every request is authenticated on its own), as are `AgentMcpServerController` and `createAgentMcpServer` — use `registerAgentTools(server, { actor, registry, policy })` on an SDK `McpServer`.
- A tool the caller may not use is not registered for its request: calling it is the protocol's "tool not found", not a tool result. A status a `@Mcp()` route answered with is a tool result with `isError`, the status leading its text and in `_meta.httpStatus` (the SDK v2 reports whatever a tool throws as a result).
- Zod 3 input schemas are advertised as a permissive object (no JSON Schema extension); calls are still validated against them.

New: `mcp` passes `@nestjs/mcp`'s own settings through (`instructions`, `http.allowedHosts`, …), and `stdio: { actor }` serves the agent's tools over stdio as that actor.
