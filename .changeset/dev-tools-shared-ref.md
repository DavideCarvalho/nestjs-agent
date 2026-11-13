---
"@dudousxd/nestjs-agent-mcp-server": patch
---

Dev MCP tools no longer print `[circular]` for a value that appears twice in a result (the same object under two fields, or twice in a list). Only a real cycle is marked `[circular]` now.
