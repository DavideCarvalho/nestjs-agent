---
"@dudousxd/nestjs-agent-dashboard": minor
---

The governance console's reads are now developer tools on the agent MCP server's dev endpoint (`/mcp/aviary`): `agent_list_runs`, `agent_get_run`, `agent_get_spend`, `agent_get_tool_stats`, `agent_get_reliability`, `agent_list_pending_approvals` and `agent_list_recent_tool_calls`. They are gated by the console's own `authorize` and registered while the console is mounted. Set `devTools: true` with `routes: false` to keep them, or `devTools: false` to turn them off. New `anyAuthorize(...forms)`: it allows when any of its `authorize` forms allows, for example a token or an admin session. An allow may now name its caller, `{ allowed: true, caller }`, which the dev endpoint logs; `authorizeByToken` names it `token:<hash>`, and `anyAuthorize` keeps the caller of the form that allowed.
