---
"@dudousxd/nestjs-agent-mcp-server": patch
---

The MCP server no longer lists or runs tools whose result is shown elsewhere (`presentation.result.kind === 'elsewhere'`), such as the generative-UI `ui__show_*`, `ui__show` and tree tools. They are `read` tools, so they used to be exposed. But all they do is push a component, an MCP client has no screen to show it on, and the model got nothing back.
