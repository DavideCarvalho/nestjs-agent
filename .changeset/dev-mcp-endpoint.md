---
"@dudousxd/nestjs-agent-mcp-server": minor
---

A dev MCP endpoint at `/mcp/aviary`, on by default: it serves the developer tools Aviary libs register in the process-wide `Symbol.for('@dudousxd/aviary:dev-tools')` slot, each lib gated by its own console `authorize`. Configure it with `devTools: { path, exclude, actions, decorators }`, or turn it off with `devTools: false`. It is stateless and read-only by default. Results are capped at 48 KB, secret-looking keys are redacted, and every call is audited. It shares nothing with the product endpoint.
