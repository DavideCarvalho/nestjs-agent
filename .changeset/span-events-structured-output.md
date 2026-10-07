---
"@dudousxd/nestjs-agent-core": patch
---

`AGENT_SPAN_EVENTS` now includes `'structured-output'`, matching the `AgentSpanEvent` type, so subscribers built from the list also see structured-output spans. A compile-time check now catches it if the list and the type drift apart again.
