---
"@dudousxd/nestjs-agent-mcp-server": patch
---

Say what `BearerTokenActorResolver`'s token comparison actually guarantees: the contents are compared in time that does not depend on them, while the length check short-circuits by design.
