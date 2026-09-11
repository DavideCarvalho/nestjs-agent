---
'@dudousxd/nestjs-agent-mcp': minor
---

Add `@dudousxd/nestjs-agent-mcp` — an MCP client, so an external Model Context Protocol server's
tools can be imported instead of writing an `@AiTool` class for each.

`AgentMcpModule.forRoot({ servers: [...] })` (and `forRootAsync`) connects to each server at boot,
lists its tools, and registers them into the same `ToolRegistry` `@AiTool` discovery writes to — so
an imported tool goes through every gate a hand-written one does: `roles`, `ability`, per-actor
`canUse`, `enabled`, an agent's tool allow-list, HITL approval, and the tool-call rows the thread,
the dashboard and Telescope already read. stdio and streamable HTTP ship with the package; anything
else (OAuth, legacy SSE, an in-process pair in a test) plugs in as a custom transport. Built on the
official `@modelcontextprotocol/sdk`.

**An imported tool is `kind: 'action'` by default** — it waits for a human. This library
auto-executes a `read` tool, and a tool defined on a remote server has effects that are not visible
from the importing codebase. MCP servers may advertise `readOnlyHint`, but that hint is asserted by
the very party whose effects it describes, so trusting it is opt-in (`kind: 'trust-annotations'`),
as is `kind: 'read'` for a server you own and audit, or a per-tool predicate.

The server's JSON Schema is enforced rather than approximated. Each tool's schema is compiled into
the Standard Schema `ToolSpec.inputSchema` requires, so the model's arguments are validated against
the real constraints — required properties, types, enums, `additionalProperties` — before the call
goes out, and the same document is exposed through the Standard JSON Schema extension so the AI SDK
adapter hands the model the real parameter shapes. A tool whose schema cannot be compiled is skipped
with a warning instead of being imported behind a permissive stand-in.

A slow or missing server costs its own tools and nothing else. An unreachable server at boot is a
warning and its tools are absent (`required: true` opts into failing boot); a hung request hits the
SDK's own per-request timeout, which cancels it on the wire; a dropped connection, a socket reset or
a retryable HTTP status is classified transient by the exported `isTransientMcpError`, recycles the
client, and is retried through core's `invokeWithTransientRetry` — the same in-place retry the agent
loop already wraps every tool with, so a retry never becomes a second durable checkpoint. A
protocol-level refusal is not retried. `McpToolsService.refresh(name?)` re-imports a server that was
down at boot without a restart.

Tool names are namespaced under their server (`github_create_issue`) and reshaped to what model
providers accept, stably across restarts — the registry is keyed by name, so an un-namespaced import
could otherwise replace an application tool silently. A collision with an already-registered name is
refused and logged rather than overwritten.
